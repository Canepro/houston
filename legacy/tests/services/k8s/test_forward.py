"""`houston.services.k8s.forward`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _FakeProc, _fake_run
import json
import pytest
import subprocess


def test_a_forward_is_confirmed_by_owning_the_socket_not_by_the_port_answering():
    """`forward_bound` asked whether the PORT answered, and lost that race 3 times
    out of 3 against a squatter -- in a tenth of a millisecond.

    `poll()` is None for a few hundred milliseconds after `Popen` while kubectl loads
    its kubeconfig and talks to the API server, and the squatter answers its socket
    instantly. So the function returned True, the dead pid was recorded after all,
    and the targeted warning it exists to produce never fired in the one scenario its
    docstring describes.

    Real sockets and a real child here, because the defect IS the timing: a stub
    would answer whatever it was told and prove nothing. Ownership has no window --
    either our pid holds a listening socket on that port or it does not.
    """
    import socket

    from houston.services import k8s

    squatter = socket.socket()
    squatter.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    squatter.bind(("127.0.0.1", 0))
    port = squatter.getsockname()[1]
    squatter.listen(5)
    try:
        # A child that exits at once, standing in for a kubectl that cannot bind.
        doomed = subprocess.Popen(["sh", "-c", "exit 1"])
        assert k8s.forward_bound(doomed, port, tries=3, interval=0.1) is False, \
            "the squatter's socket was accepted as our child's"
        # And the ownership question itself, both ways.
        assert k8s.pid_owns_port(doomed.pid, port) is False
        import os
        assert k8s.pid_owns_port(os.getpid(), port) is True, \
            "this process really does hold that socket"
    finally:
        squatter.close()


def test_a_forward_that_hid_its_arguments_is_not_called_dead(monkeypatch):
    """`forward_alive` identifies our port-forward from /proc/<pid>/cmdline -- and on
    a host where `kubectl` is a symlink to `k3s`, that command line is empty.

    k3s ships kubectl as a multi-call binary: dispatching rewrites its own argv, so
    the process shows `kubectl` and then nothing. Measured on such a host -- `ss
    -ltnp` reported that exact pid holding both :3000 sockets while this function
    returned False. Reading that as "the forward is gone" made `ensure_port_forward`
    respawn onto a port its own live forward already held, every single call, and told
    the reader the URL was not published while it was answering 200.

    An argv with nothing in it to check is "I cannot identify it this way", not a
    mismatch. Same distinction the rest of this module is built on.
    """
    from houston.services import k8s

    class _Proc:
        def __init__(self, path):
            self.path = str(path)

        def read_bytes(self):
            if self.path.endswith("/cmdline"):
                return cmdline
            raise OSError("no")

        def read_text(self, encoding=None):
            if self.path.endswith("/comm"):
                return comm
            raise OSError("no")

    monkeypatch.setattr(k8s.forward, "Path", _Proc)
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s.forward, "pid_owns_port", lambda *a, **kw: port_up)

    # The k3s shape: argv[0] and a hundred empty slots.
    cmdline, comm, port_up = b"kubectl \0" + b"\0" * 100, "kubectl", True
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is True

    # ...but only while the port it was started for is actually held. Three facts
    # together: our recorded pid, still a kubectl, and the port is up.
    port_up = False
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is False

    # A recycled pid running something else is still refused.
    cmdline, comm, port_up = b"nginx\0", "nginx", True
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is False

    # And a FULL argv is still matched strictly -- the strong path is unchanged, so a
    # different workspace's forward on a recycled pid does not pass.
    cmdline = b"\0".join([b"kubectl", b"--context", b"c", b"-n", b"houston-OTHER",
                          b"port-forward", b"deployment/x", b"3000:3000"])
    comm = "kubectl"
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is False
    cmdline = cmdline.replace(b"houston-OTHER", b"houston-k")
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is True


def test_a_recycled_pid_is_not_our_port_forward(monkeypatch):
    """The check was "is this process a kubectl port-forward" -- liveness wearing
    identity's clothes.

    A recycled pid belonging to another workspace's forward, or another user's on a
    shared box, passed it: so houston could believe a workspace was reachable when it
    was not, decline to start the forward it needed, and signal a stranger's process at
    teardown. The argv already carries the proof.
    """
    from houston.services import k8s

    def _argv(*parts):
        class _P:
            def read_bytes(self):
                return "\0".join(parts).encode()
        monkeypatch.setattr(k8s.forward, "Path", lambda _p: _P())

    ours = ("kubectl", "--context", "c", "-n", "houston-mine", "port-forward",
            "deployment/rocketchat-rocketchat", "3001:3000")
    _argv(*ours)
    assert k8s.forward_alive(42, namespace="houston-mine", host_port=3001)

    # Someone else's workspace, same box, recycled pid.
    _argv("kubectl", "--context", "c", "-n", "houston-theirs", "port-forward",
          "deployment/rocketchat-rocketchat", "3002:3000")
    assert not k8s.forward_alive(42, namespace="houston-mine", host_port=3001)

    # Same namespace, different port -- and a substring test would have matched.
    _argv("kubectl", "--context", "c", "-n", "houston-mine", "port-forward",
          "deployment/rocketchat-rocketchat", "13001:3000")
    assert not k8s.forward_alive(42, namespace="houston-mine", host_port=3001), \
        "13001 must not satisfy 3001"

    # Not a port-forward at all.
    _argv("python", "-m", "http.server")
    assert not k8s.forward_alive(42, namespace="houston-mine", host_port=3001)


def test_a_forward_that_only_got_one_address_family_is_not_certified():
    """K-16. `kubectl port-forward` binds "localhost", which is BOTH 127.0.0.1 and
    [::1]. If an IPv4-only process already holds the port kubectl does NOT fail --
    it binds [::1] alone and runs happily -- and `pid_owns_port` said yes, so
    `forward_bound` certified a URL on which every IPv4 client reached the squatter.

    Reproduced live with a real kubectl forward and an IPv4 squatter: the old check
    True, the new one False, `127.0.0.1` serving a different program. Here the
    squatter is a CHILD process, because a socket this process binds is by definition
    its own and would make the split untestable.
    """
    import os
    import socket
    import sys
    import time as _time

    from houston.services import k8s

    mine = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        mine.bind(("::1", 0))
    except OSError:
        mine.close()
        pytest.skip("no IPv6 loopback here to build the split with")
    mine.listen(1)
    port = mine.getsockname()[1]
    try:
        # Only this process holds it: exclusive, which is the healthy forward.
        assert k8s.pid_owns_port(os.getpid(), port) is True
        assert k8s.pid_owns_port_exclusively(os.getpid(), port) is True
        # A pid that holds nothing on it answers no to both.
        assert k8s.pid_owns_port_exclusively(1, port) is False

        squatter = subprocess.Popen(
            [sys.executable, "-c",
             "import socket,time;s=socket.socket();"
             "s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);"
             f"s.bind(('127.0.0.1',{port}));s.listen(1);time.sleep(30)"])
        try:
            for _ in range(50):
                if len(k8s._listening_inodes(port)) > 1:
                    break
                _time.sleep(0.1)
            assert len(k8s._listening_inodes(port)) > 1, "the split never formed"
            # THE SPLIT. Presence still says yes -- our IPv6 socket is really there --
            # and that is exactly the answer that certified a broken URL.
            assert k8s.pid_owns_port(os.getpid(), port) is True
            assert k8s.pid_owns_port_exclusively(os.getpid(), port) is False
        finally:
            squatter.terminate()
            squatter.wait(timeout=10)
    finally:
        mine.close()


def test_a_port_change_retires_the_previous_forward(monkeypatch):
    """K-06. `forward_alive` identifies a forward by namespace AND port, which is
    right for "is what I recorded still up" and wrong for "is there an old one to
    retire": `up --port 3261` asked about the NEW port, got False, recorded pid 0 and
    left the old kubectl holding 3260 with nothing able to find it again. It survived
    `down --volumes` for the same reason.
    """
    from houston.services import k8s

    signalled: list[int] = []
    monkeypatch.setattr(k8s.os, "kill", lambda pid, sig: signalled.append(pid))
    monkeypatch.setattr(k8s.forward, "forward_alive",
                        lambda pid, **kw: kw.get("host_port") == 3260)

    # Asked about the port it is actually on: retired.
    assert k8s.stop_forward(4242, namespace="ns", host_port=3260) is True
    assert signalled == [4242]
    # Asked about the new port: not our forward, and nothing is signalled.
    signalled.clear()
    assert k8s.stop_forward(4242, namespace="ns", host_port=3261) is False
    assert signalled == []
    # No recorded pid at all is not an error.
    assert k8s.stop_forward(0, namespace="ns", host_port=3260) is False


def test_the_port_forward_targets_the_deployment_not_the_service(monkeypatch, tmp_path):
    """`port-forward svc/...` needs a ready ENDPOINT, and a Service has none until
    its pod passes readiness. The first version started the forward straight after
    `helm install`, kubectl found nothing to attach to and exited, and the URL that
    `up` printed never answered -- a lie rather than a delay.

    A deployment target only needs a pod to EXIST.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    spawned = []
    # "Running", not a pod name: kubectl refuses a ContainerCreating pod, so
    # waiting for existence alone spawned a forward that died immediately.
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        # `-o json` now, because the pod wait has to tell a REFUSED read from "not
        # Running yet" -- empty stdout was identical for both, and it waited 40 x 3s
        # against a cluster that had been destroyed.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "Running")}))
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda argv, **kw: spawned.append(argv) or _FakeProc(4242))
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s.forward, "pid_owns_port_exclusively", lambda *a, **kw: True)
    pid = k8s.port_forward("k", namespace="houston-k", context=k8s.CONTEXT,
                           host_port=3010, sleep=lambda _s: None)
    assert pid == 4242
    argv = spawned[0]
    target = argv[argv.index("port-forward") + 1]
    assert target.startswith("deployment/"), f"forwarded to {target}"
    assert argv[-1] == "3010:3000", "the container port is 3000; the Service is 80"


def test_a_dead_port_forward_is_replaced_rather_than_trusted(monkeypatch, tmp_path):
    """A forward dies with its pod, so a recorded pid is not evidence it is alive --
    and a recycled pid is not evidence it is OURS. `ready` and `start` re-establish
    through this rather than assuming the create-time pid still holds."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert k8s.forward_alive(None) is False
    assert k8s.forward_alive(999999999) is False, "a pid that cannot be read is dead"
    # Our own process is alive but is NOT a port-forward, which is the recycled-pid
    # case: believing it would leave the workspace unreachable AND, at teardown,
    # signal something unrelated.

    spawned = []
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        # `-o json` now, because the pod wait has to tell a REFUSED read from "not
        # Running yet" -- empty stdout was identical for both, and it waited 40 x 3s
        # against a cluster that had been destroyed.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "Running")}))
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda argv, **kw: spawned.append(argv) or _FakeProc(77))
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s.forward, "pid_owns_port_exclusively", lambda *a, **kw: True)
    assert k8s.ensure_port_forward("k", namespace="ns", context=k8s.CONTEXT,
                                   host_port=3010, pid=999999999) == 77
    assert spawned, "it trusted a dead pid"


def test_bind_reaches_the_port_forward_instead_of_being_dropped(monkeypatch, tmp_path):
    """`--bind 0.0.0.0` was accepted on the Kubernetes path and then dropped, which
    is worse than refusing it: a workspace created for a shared box was reachable
    only from localhost and nothing said so.

    kubectl binds 127.0.0.1 by default and takes `--address`, so this is a real
    setting rather than a Compose-only one.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        # The pod wait reads `-o json` now; without this it sees a refused read and
        # correctly declines to wait forever, which is a different test than this one.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "true")}))
    spawned: list = []
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda argv, **kw: spawned.append(argv) or _FakeProc(9))
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s.forward, "pid_owns_port_exclusively", lambda *a, **kw: True)

    k8s.port_forward("n", namespace="ns", context=k8s.CONTEXT, host_port=3000,
                     bind_host="0.0.0.0", sleep=lambda _s: None)
    assert "--address" in spawned[0] and "0.0.0.0" in spawned[0], spawned[0]

    # Loopback needs no flag, and the default must stay loopback -- repros ship
    # fixed weak credentials, so widening is opt-in on both runtimes.
    for quiet in ("", "127.0.0.1", "localhost"):
        spawned.clear()
        k8s.port_forward("n", namespace="ns", context=k8s.CONTEXT, host_port=3000,
                         bind_host=quiet, sleep=lambda _s: None)
        assert "--address" not in spawned[0], quiet


def test_the_grafana_url_is_not_handed_over_before_the_forward_answers(monkeypatch):
    """`kubectl port-forward` returns a pid before it binds the socket.

    The workspace path already carries a test named for this mistake. The Grafana
    path repeated it and the deployment matrix caught it: `houston monitor`
    reported attached and exited 0, and a curl to the URL it printed got nothing at
    all -- a link handed over that quietly did not work.
    """
    from houston.services import k8s

    slept = []
    assert k8s.forward_reachable(1, tries=3, interval=0.01,
                                 sleep=slept.append) is False
    assert len(slept) == 3, "must actually retry rather than check once"


def test_ready_confirms_the_socket_not_just_the_pid(monkeypatch, tmp_path):
    """`ready` exited 0 on a workspace whose URL answered nothing, after `restart`.

    The pod being Ready is Kubernetes' answer to a different question. `kubectl
    port-forward` returns a pid before it has bound the socket, so declaring ready
    on the strength of the pid is a guess -- and the live run caught it being wrong:
    `ready` returned success and the very next request to the URL it had just
    confirmed got nothing.

    So the loop keeps going until something actually answers on the port. This is
    the same defect as the Grafana URL, in the place it was fixed second.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3999",
                           host_port=3999, version_source="t")
    from houston.services import topology
    topology.stamp(m.extra, topology.KUBERNETES)

    monkeypatch.setattr(k8s.status, "workspace_ready", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.forward, "ensure_port_forward", lambda *a, **kw: 4242)
    monkeypatch.setattr(lc.runner.record, "update_meta", lambda *a, **kw: None)

    # Never reachable -> must NOT report ready, must raise the timeout instead.
    monkeypatch.setattr(k8s.forward, "forward_reachable", lambda *a, **kw: False)
    try:
        lc._wait_serving_kubernetes(m, lc.null_emit, timeout=0.2)
    except errors.NotReadyError:
        pass
    else:
        raise AssertionError("a URL that answers nothing must not report ready")

    # Reachable AND Rocket.Chat answering -> ready. Both are now required: the port
    # answering says only that the port answers, so /api/info is what says the thing
    # on the other end is this workspace.
    monkeypatch.setattr(k8s.forward, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda url, **kw: {"version": "8.5.1"})
    out = lc._wait_serving_kubernetes(m, lc.null_emit, timeout=5.0)
    assert out == {"ready": True, "url": "http://localhost:3999"}, out


def test_ready_requires_the_same_forward_to_survive_two_serving_checks(
        monkeypatch, tmp_path):
    """L2/L3: a freshly repaired forward can serve once and then die with its pod.

    That is the exact live failure recorded by the Phase 2b battery: ``ready`` saw
    Rocket.Chat, exited zero, and the battery's immediately following /api/info
    request got connection-refused.  A second forward replacing the first is proof
    that the first observation was transient, not proof that the URL is stable.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3999",
                           host_port=3999, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)

    repaired: list[int] = []
    pids = iter((101, 202, 202))

    def ensure(*args, **kwargs):
        pid = next(pids)
        repaired.append(pid)
        return pid

    monkeypatch.setattr(k8s.status, "workspace_ready", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.forward, "ensure_port_forward", ensure)
    monkeypatch.setattr(k8s.forward, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda *a, **kw: {"version": "8.5.1"})
    monkeypatch.setattr(lc.runner.record, "update_meta", lambda *a, **kw: None)
    monkeypatch.setattr(lc.ready.time, "sleep", lambda _seconds: None)

    assert lc._wait_serving_kubernetes(m, lc.null_emit, timeout=5.0)["ready"] is True
    assert repaired == [101, 202, 202], (
        "ready certified the first one-request forward instead of requiring the "
        "same repaired forward to survive a second serving check")


def test_a_port_forward_that_never_bound_is_not_recorded_as_a_pid(monkeypatch, tmp_path):
    """`port_forward` returned `proc.pid` the instant it spawned kubectl.

    kubectl cannot share a port: if something already holds it, it prints
    `Unable to listen on port N: bind: address already in use` and exits within
    milliseconds -- to DEVNULL, so nothing saw it -- and the pid was recorded anyway.
    The record then named a dead process while the squatter answered the URL, which is
    the first half of `ready` certifying somebody else's software.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        # `-o json` now, because the pod wait has to tell a REFUSED read from "not
        # Running yet" -- empty stdout was identical for both, and it waited 40 x 3s
        # against a cluster that had been destroyed.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "Running")}))
    # kubectl exited: it never got the socket. Something else answers on the port,
    # which is exactly why this must not be read as success.
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda argv, **kw: _FakeProc(4242, exited=1))
    # THE SQUATTER HOLDS THE PORT, and our child never got it. The code asks the
    # ownership question now, because asking "does the port answer?" is answered
    # `True` by the squatter -- measured, 3 times out of 3, in a tenth of a
    # millisecond, so the warning below never fired in the one scenario it is for.
    monkeypatch.setattr(k8s.forward, "pid_owns_port_exclusively", lambda *a, **kw: False)
    # AND SOMETHING REALLY IS LISTENING, which is what makes this the squatter case.
    # The warning distinguishes a collision from a pod that moved, so the double has
    # to say which of the two this is -- see the second half of this test.
    monkeypatch.setattr(k8s.forward, "_listening_inodes", lambda port: {"sock:[1]"})
    said: list = []
    pid = k8s.port_forward("k", namespace="ns", context=k8s.CONTEXT, host_port=3010,
                           emit=lambda e: said.append(e.message),
                           sleep=lambda _s: None)
    assert pid == 0, "a pid was recorded for a forward that never came up"
    assert any("something else already holds it" in m for m in said), said

    # THE OTHER CAUSE, and it is the commonest one. During an upgrade or any rolling
    # update the pod the forward attached to goes away, kubectl exits, and NOTHING
    # holds the port. This used to print the squatter message anyway and tell the
    # reader to run `down` then `up` -- measured on a live upgrade, where the next
    # readiness check re-established the forward on its own seconds later. A false
    # alarm that prescribes destroying the workspace is worse than no alarm.
    monkeypatch.setattr(k8s.forward, "_listening_inodes", lambda port: set())
    said.clear()
    assert k8s.port_forward("k", namespace="ns", context=k8s.CONTEXT, host_port=3010,
                            emit=lambda e: said.append(e.message),
                            sleep=lambda _s: None) == 0
    assert any("not a collision" in m for m in said), said
    assert not any("down --name" in m for m in said), \
        "nothing here justifies telling somebody to destroy the workspace"

    # And the ordinary case still works: child alive and holding its own socket.
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda argv, **kw: _FakeProc(4242))
    monkeypatch.setattr(k8s.forward, "pid_owns_port_exclusively", lambda *a, **kw: True)
    assert k8s.port_forward("k", namespace="ns", context=k8s.CONTEXT, host_port=3010,
                            sleep=lambda _s: None) == 4242


def _a_url_served_by_something_else(monkeypatch, tmp_path):
    """An endpoint that answers, but not with Rocket.Chat."""
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3998",
                           host_port=3998, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)

    monkeypatch.setattr(k8s.status, "workspace_ready", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.forward, "ensure_port_forward", lambda *a, **kw: 0)
    monkeypatch.setattr(lc.runner.record, "update_meta", lambda *a, **kw: None)
    # The port answers -- but not with Rocket.Chat.
    monkeypatch.setattr(k8s.forward, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda url, **kw: None)
    monkeypatch.setattr(k8s.status, "terminal_pod_failure", lambda *a, **kw: None)

    # WHOSE forward holds the port is deliberately not part of the test, because it
    # turned out not to be the right question. The first version of this fix refused
    # only when OUR forward was dead, and a live run found the case that misses: on a
    # dual-stack box kubectl binds `[::1]` quite happily while a squatter holds
    # `127.0.0.1`, so the forward is ALIVE, `localhost` resolves v4-first to the
    # squatter, and `ready` polled to a timeout instead of saying so. Measured with
    # `ss -ltnp`: python on 127.0.0.1:3001 and kubectl on [::1]:3001 at once.
    #
    # The workspace's own state is the sound test: Kubernetes says ready, the port
    # answers, and it is not Rocket.Chat -- so that port is not this workspace,
    # whoever owns the socket.
    # Two strikes rather than the shipped four: this test is about the refusal, and
    # the grace period has its own assertion below.
    monkeypatch.setattr(lc.tuning, "FOREIGN_PORT_STRIKES", 2)
    return k8s, m


def test_ready_refuses_a_url_served_by_something_that_is_not_rocketchat(
        monkeypatch, tmp_path):
    """`ready` printed "is serving at <url>" and exited 0 for a URL a FOREIGN process
    was serving.

    The Kubernetes readiness path concluded from a Ready pod plus "the port answers",
    and never asked Rocket.Chat anything -- while the Docker path has always gone
    through `rcapi.wait_ready`, which polls /api/info. So the two runtimes disagreed
    about what "ready" means, and the weaker one certified the wrong software. The
    port is validated only at create time and 3000+ is the most contested range on a
    dev box, so this is an ordinary event, not a contrived one.

    Occupancy is not identity. A support engineer reading that URL draws every
    conclusion about a program that is not Rocket.Chat.
    """
    k8s, m = _a_url_served_by_something_else(monkeypatch, tmp_path)
    for alive in (False, True):
        monkeypatch.setattr(k8s.forward, "forward_alive", lambda *a, **kw: alive)
        with pytest.raises(errors.ConflictError) as caught:
            lc._wait_serving_kubernetes(m, lc.null_emit, timeout=60.0)
        said = str(caught.value)
        assert "3998" in said and "not with Rocket.Chat" in said, said
        assert "trusted to be this workspace" in said, \
            "say that the URL itself is not evidence"
        assert "IPv4" in said, "the dual-stack case is the one a reader cannot guess"

    # But NOT on the first look. A pod that has only just passed its probe may take a
    # moment more to serve, and accusing somebody then is worse than waiting -- so the
    # refusal needs consecutive strikes, and without room for them this is an honest
    # timeout rather than an accusation.
    monkeypatch.setattr(lc.tuning, "FOREIGN_PORT_STRIKES", 10**6)
    with pytest.raises(errors.NotReadyError):
        lc._wait_serving_kubernetes(m, lc.null_emit, timeout=0.5)


def test_a_scenario_forward_targets_the_deployment_not_the_service(monkeypatch):
    """A live OIDC workspace: Keycloak 1/1 Running, the recorded forward pid gone,
    nothing answering on 8085.

    `kubectl port-forward svc/...` dies when the Service's endpoint churns. The
    workspace's own forward learned this and uses `deployment/`; scenario UIs then
    reintroduced it. It also has to publish the CONTAINER port -- a deployment
    forward cannot use the Service's port, and for SAML those differ (8081 -> 8080).
    """
    import subprocess

    from houston.services import k8s

    spawned = []

    def fake_run(argv, **kw):
        if "get" in argv and "svc" in argv:
            out = "keycloak 8081 8080\n"
        elif "endpointslices" in argv:
            # EndpointSlice, not the deprecated `endpoints`: kubectl warns on every
            # call to the old one ("v1 Endpoints is deprecated in v1.33+") and this
            # is a WAIT LOOP, so the day it stops being served the old call would
            # spin to its timeout rather than fail visibly.
            out = json.dumps({"items": [
                {"metadata": {"labels": {"kubernetes.io/service-name": "keycloak"}},
                 "endpoints": [{"conditions": {"ready": True}}]}]})
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    # `_FakeProc`, because the code asks `poll()` now: a scenario forward is only
    # published if OUR kubectl got the socket, not merely if the port answers.
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda argv, **kw: (spawned.append(argv), _FakeProc(4242))[1])
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s.forward, "pid_owns_port_exclusively", lambda *a, **kw: True)

    out = k8s.scenario_ui_forwards("w", namespace="houston-w", context=k8s.CONTEXT,
                                   sleep=lambda _s: None)
    assert out == {8081: 4242}, out
    argv = spawned[0]
    assert "deployment/keycloak" in argv, argv
    assert not any(a.startswith("svc/") for a in argv), argv
    # host:container, so the CONTAINER port is what it maps to.
    assert "8081:8080" in argv, argv


def test_a_dead_port_forward_is_said_out_loud_and_names_its_repair(monkeypatch, tmp_path):
    """`list` showed `running` beside a URL that refused connections, and nothing
    anywhere said `ready` was the repair.

    A port-forward dies with its pod, so this is ordinary rather than exceptional --
    a restart, a rescheduled pod, a reboot. And "running" is not WRONG: it is the
    pods' state, and they may be perfectly healthy. That is exactly why the reader had
    nothing to go on -- the state was right, the URL was dead, and the two facts never
    met. So the note is derived on every read rather than recorded, and disappears the
    moment the forward is back.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra.update({"context": k8s.CONTEXT, "namespace": "houston-k",
                    "port_forward_pid": 4242})

    def titles(meta):
        return [g["title"] for g in lc.note_groups_of(meta)]

    monkeypatch.setattr(k8s.forward, "forward_alive", lambda *a, **kw: False)
    groups = lc.note_groups_of(m)
    dead = [g for g in groups if g["title"] == "The URL is not published right now"]
    assert dead, titles(m)
    assert any("houston ready --name k" in c for c in dead[0]["commands"]), dead[0]
    assert any("localhost:3000" in b for b in dead[0]["body"]), dead[0]
    # It must not read as an accusation against Rocket.Chat, which may be fine.
    assert any("says nothing about Rocket.Chat" in b for b in dead[0]["body"])

    # A live forward says nothing at all.
    monkeypatch.setattr(k8s.forward, "forward_alive", lambda *a, **kw: True)
    assert "The URL is not published right now" not in titles(m)

    # AND NEITHER DOES A RECORD WITH NO PID. `forward_alive(None)` is False, and
    # reading that as "no forward is running" is the exact confusion this release
    # spent itself removing -- a record written before the pid was tracked tells us
    # nothing about what is listening, so a note claiming a fact must stay quiet.
    monkeypatch.setattr(k8s.forward, "forward_alive", lambda *a, **kw: False)
    m.extra.pop("port_forward_pid")
    assert "The URL is not published right now" not in titles(m), \
        "no pid recorded is 'I cannot say', not 'nothing is running'"

    # A Compose workspace is not affected: it publishes a real port.
    c = lc.runner.Metadata(name="d", project="houston-d", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3001",
                           host_port=3001, version_source="t")
    assert "The URL is not published right now" not in titles(c)
