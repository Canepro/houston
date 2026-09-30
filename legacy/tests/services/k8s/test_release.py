"""`houston.services.k8s.release`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
import pytest
import subprocess


def test_a_fast_install_does_not_narrate_a_step_that_is_already_over(monkeypatch):
    """The quiet window is the point: a warm cluster installs in seconds and a line
    saying "still installing" about a step that has finished is noise, not progress.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.release, "clear_pending_release", lambda *a, **k: None)
    monkeypatch.setattr(k8s.release, "_pods_waiting",
                        lambda ns, ctx: pytest.fail("probed pods for a fast install"))
    said: list = []
    monkeypatch.setattr(k8s.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 0, "", ""))
    k8s.install(namespace="ns", context="c", values={},
                emit=lambda e: said.append(e.message))
    assert not [m for m in said if "still installing" in m], said


def test_a_failed_create_leaves_no_namespace_nobody_can_see(monkeypatch, tmp_path):
    """repro.json is written only after a successful create, so a namespace that
    survives a failure is invisible to `list` and to `down`. On Compose a failed
    `up` at least leaves a workspace directory you can find."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    deleted = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        joined = " ".join(argv)
        if "get clusters" in joined:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in joined:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in joined:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "get storageclass" in joined:
            return sp.CompletedProcess(argv, 0, '{"items":[{"metadata":{"name":"s",'
                '"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}]}', "")
        if "{.metadata.labels}" in joined:
            # WHAT A REAL CLUSTER SAYS about a namespace that is not there. This spy
            # answered every `get namespace` with rc=0 and an empty body, which now
            # reads as "exists, carrying no labels" -- and an unlabelled namespace is
            # refused rather than adopted, because houston cannot tell one an older
            # version made from one somebody else made.
            return sp.CompletedProcess(
                argv, 1, "", 'Error from server (NotFound): namespaces "x" not found')
        if "get ingressclass" in joined or "get namespace" in joined:
            return sp.CompletedProcess(argv, 0, "", "")
        if "delete namespace" in joined:
            deleted.append(joined)
        if "search repo" in joined:
            return sp.CompletedProcess(argv, 0,
                '[{"version":"7.0.2","app_version":"8.6.1"}]', "")
        if "jsonpath" in joined:
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            return sp.CompletedProcess(argv, 0, "1", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.release, "apply", lambda *a, **k: None)
    # Mongo 8.0 takes the operator path; without these the wait polls a real clock.
    monkeypatch.setattr(k8s.operator, "ensure_operator", lambda **k: None)
    monkeypatch.setattr(k8s.operator, "wait_for_mongodb", lambda **k: None)
    monkeypatch.setattr(k8s.release, "install",
                        lambda **k: (_ for _ in ()).throw(
                            errors.CreateFailedError("helm exploded")))
    resolved = type("R", (), {"rc_version": "8.6.1", "mongo_tag": "8.0",
                              "rc_image": "img", "oplog": False})()
    with pytest.raises(errors.CreateFailedError):
        k8s.create_workspace(name="t", resolved=resolved, host_port=3000,
                             microservices=False)
    assert deleted, "the namespace survived a failed create"
    assert "houston-t" in deleted[0]


def test_the_install_is_idempotent_so_bringing_one_back_works(monkeypatch):
    """`helm install` fails on a release that already exists, which is every `up`
    over an existing workspace and every retry after a partial failure."""
    from houston.services import k8s

    seen: list = []
    monkeypatch.setattr(k8s.subprocess, "run",
                        lambda argv, **kw: seen.append(argv) or
                        __import__("subprocess").CompletedProcess(argv, 0, "", ""))
    k8s.install(namespace="ns", context=k8s.CONTEXT, values={}, chart_version="7.0.0")
    # THE INSTALL CALL, not the first subprocess call. `install` now asks for the
    # release's state first, because a release left `pending-install` by a killed
    # operation blocks every later attempt -- so the install is no longer argv[0] and
    # asserting on the ordinal was testing the call order rather than the property.
    installs = [a for a in seen if a[:3] == ["helm", "upgrade", "--install"]]
    assert len(installs) == 1, seen
    assert "--install" in installs[0], installs[0][:4]


def test_the_longest_step_of_a_create_says_what_it_is_waiting_for(monkeypatch):
    """MEASURED on a real EKS create: 254 seconds between "installing
    rocketchat/rocketchat" and the next line, and nothing in between.

    `--atomic` (helm 3) and `--rollback-on-failure` (helm 4) both imply `--wait`, so
    helm blocks until the pods are Ready and prints nothing at all while it does. The
    comment at the call site claimed that passing `emit` made "helm's own progress
    reach both front ends", which it never could: the output is captured and comes
    back in one piece at the end.

    Four minutes of silence is where somebody decides the tool has hung and kills it,
    which leaves a half-installed release for the next `up` to clear.
    """
    import time as _time

    from houston.services import k8s

    monkeypatch.setattr(k8s.tuning, "INSTALL_QUIET_S", 1)
    monkeypatch.setattr(k8s.tuning, "INSTALL_REPORT_EVERY_S", 1)
    monkeypatch.setattr(k8s.release, "clear_pending_release", lambda *a, **k: None)
    monkeypatch.setattr(k8s.release, "_pods_waiting",
                        lambda ns, ctx: "1 starting (usually pulling the image)")
    said: list = []

    def slow(argv, **kw):
        _time.sleep(2.4)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.subprocess, "run", slow)
    k8s.install(namespace="ns", context="c", values={},
                emit=lambda e: said.append(e.message))
    progress = [m for m in said if "still installing" in m]
    assert progress, f"the longest step of a create said nothing: {said}"
    assert "pulling the image" in progress[0], progress
