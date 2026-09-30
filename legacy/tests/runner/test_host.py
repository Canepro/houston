"""`houston.runner.host`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from edgehelpers import _acme_workspace
from houston import runner
import pytest


def test_capacity_says_which_runtime_its_room_is_denominated_in():
    """`room` divided by WORKSPACE_MB (1100) and was reported as the machine's
    capacity whatever runtime the reader was about to use.

    A Kubernetes microservices workspace costs 2400 plus 600 for a control plane, which
    `runtime_cost` already knows and `capacity()` was never told. Observed in the same
    minute: doctor saying "4128 MB available — room for about 1 more workspace" and
    `up --runtime kubernetes` exiting 3 with "needs about 2400 MB and only 2144 MB is
    free to use" -- exactly the disagreement `capacity()`'s own docstring says the one
    formula exists to prevent.
    """
    from houston.services import lifecycle as lc

    # `runner.host`, not the façade: restoring writes a REAL attribute that shadows
    # `__getattr__`. This one poisoned fourteen later tests.
    real = runner.host.host_memory
    try:
        runner.host.host_memory = lambda: (16000, 12000, 0)
        cap = lc.capacity()
    finally:
        runner.host.host_memory = real

    assert cap["known"] is True
    assert cap["room_denominated_in"] == "docker", cap
    rooms = cap["room_by_runtime"]
    assert set(rooms) == {"docker", "kubernetes-monolith", "kubernetes-microservices"}
    # Strictly fewer of the expensive ones, which is the whole point.
    assert rooms["docker"] > rooms["kubernetes-monolith"] >= rooms["kubernetes-microservices"], rooms
    # And `room` keeps its old meaning for the three existing consumers.
    assert cap["room"] == rooms["docker"], cap


def test_a_host_we_cannot_measure_is_never_refused(monkeypatch):
    """Not Linux: skip rather than guess. A wrong refusal is worse than none."""
    from houston import runner
    from houston.services import lifecycle as lc

    monkeypatch.setattr(runner.host, "host_memory", lambda: None)
    lc.check_capacity(lc.CreateReq(version="8.5.1"))       # must not raise


def test_host_memory_prefers_available_over_free():
    """MemFree excludes the page cache, which the kernel reclaims on demand -- it
    looks alarming on a healthy box and reassuring on a doomed one."""
    from houston import runner

    mem = runner.host_memory()
    if mem is None:
        pytest.skip("not Linux")
    total, avail, _swap = mem
    assert total > 0 and 0 < avail <= total


def test_a_missing_compose_plugin_is_a_preflight_not_a_mid_create_crash(monkeypatch):
    """`docker_available()` runs `docker info`, which says nothing about the compose
    plugin -- and a box can have one without the other. Reported from a fresh Amazon
    Linux EC2 instance where `docker ps` worked and both entry points died from the
    middle of their work with docker's own unhelpful pair:

        docker: 'compose' is not a docker command.
        unknown shorthand flag: 'd' in -d

    `serve --domain` reported only "the edge did not start" with `docker ps -a` empty."""
    from houston import errors, runner
    from houston.services import lifecycle as lc

    monkeypatch.setattr(runner.host, "docker_available", lambda: True)

    monkeypatch.setattr(runner.host, "compose_version", lambda: None)
    try:
        lc.require_docker()
    except errors.PreflightError as exc:
        assert "not installed" in str(exc), exc
        assert "docker-compose-plugin" in str(exc), "name the package to install"
        assert exc.exit_code == 3, "an unusable environment is a preflight, not a crash"
    else:
        raise AssertionError("accepted a box with no compose plugin")

    # v1 is not enough either, and it says which version it found.
    monkeypatch.setattr(runner.host, "compose_version", lambda: "1.29.2")
    try:
        lc.require_docker()
    except errors.PreflightError as exc:
        assert "1.29.2" in str(exc), exc
    else:
        raise AssertionError("accepted Compose v1")

    # And v2 passes, which is every working box.
    monkeypatch.setattr(runner.host, "compose_version", lambda: "2.29.1")
    lc.require_docker()


def test_doctor_names_the_leftovers_the_rename_could_not_move(tmp_path, monkeypatch):
    """Three classes of thing are outside the migration's reach: root-owned files, the
    shared edge, and copies this tool installed into other tools' directories.

    Each is INVISIBLE rather than broken -- a stale systemd unit fails at boot, an
    orphaned skill teaches an agent commands that no longer exist -- so the whole
    value is that something says so. Every row carries the command that fixes it.
    """
    from houston import runner as runnersvc
    from houston.services import doctor

    # The DEVELOPER's own box may be running a pre-rename edge, which would make this
    # pass for the wrong reason and the clean-box test below fail for one.
    monkeypatch.setattr(runnersvc.host, "docker_available", lambda **kw: False)
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".rc-repro").mkdir()
    (tmp_path / ".agents" / "skills" / "rc-repro").mkdir(parents=True)

    rows = [r for r in doctor.run_checks()["checks"] if r["check"] == "legacy-artifacts"]
    found = " ".join(r["message"] for r in rows)
    assert ".rc-repro" in found and "skills/rc-repro" in found, found
    assert all(r["status"] == "warn" for r in rows), rows
    assert "rm -rf" in found, "a row that does not say how to fix it is just noise"


def test_doctor_is_silent_about_a_box_that_never_ran_the_old_name(tmp_path,
                                                                  monkeypatch):
    """A clean box must get no rows about leftovers it does not have -- otherwise the
    check becomes a permanent paragraph everybody learns to scroll past."""
    from houston import runner as runnersvc
    from houston.services import doctor

    monkeypatch.setattr(runnersvc.host, "docker_available", lambda **kw: False)
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("HOME", str(tmp_path))

    rows = [r for r in doctor.run_checks()["checks"] if r["check"] == "legacy-artifacts"]
    assert rows == [], rows


def test_docker_available_is_memoised_but_forcible(monkeypatch):
    """Opts OUT of conftest's engine stub, because this tests the stubbed function.

    `_deterministic_engine` replaces `docker_available` so the suite's result does not
    depend on whether this machine has a docker binary. That is exactly what must not
    happen here: the memoisation being tested belongs to the real one.
    """
    import subprocess

    from houston import runner

    monkeypatch.undo()                  # drop the autouse stub, keep the fixture's home
    monkeypatch.setenv("HOUSTON_HOME", "/tmp/houston-memo-test")
    runner.invalidate_docker_queries()
    calls = []

    def fake_run(*a, **k):
        calls.append(1)
        return subprocess.CompletedProcess(a[0] if a else [], 0, "", "")

    monkeypatch.setattr(runner.docker, "run", fake_run)
    for _ in range(5):
        runner.docker_available()
    assert len(calls) == 1
    runner.docker_available(max_age=0)          # doctor wants the truth, now
    assert len(calls) == 2


def test_tls_status_reports_the_names_when_there_is_no_subject(tmp_path, monkeypatch):
    """The row a reader checks to confirm the certificate is for the right name."""
    from typer.testing import CliRunner

    from houston import cli, runner
    from houston import tls as tlsmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(runner.host, "docker_available", lambda **k: True)
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **k: {
        "serving": True, "fallback": False, "issuer": "CN = houston local CA",
        "subject": "", "dates": "notAfter=Nov 23 2026", "names": ["t1.example.com"],
        "trusted": True, "trusted_via_ca": True, "error": ""})
    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "t1.example.com" in (r.output or ""), r.output
    assert "Subject" not in (r.output or ""), \
        "the row is what the certificate is VALID FOR, which a subject may not carry"


def test_tls_status_does_not_report_a_cluster_placeholder_as_this_workspaces_cert(
        tmp_path, monkeypatch):
    """It probed 127.0.0.1 ONLY, so on a box where something else holds IPv4 :443 it
    reported that thing's certificate as the workspace's.

    Found live: k3s ServiceLB DNATs IPv4 :443 into the cluster, whose ingress is also
    Traefik -- so `tls-status` on a healthy local-CA workspace showed
    `CN = TRAEFIK DEFAULT CERT` and advised that "ACME never succeeded", about a
    workspace that uses no ACME at all. `curl` and `tls.verify` on the NAME both
    agreed the real certificate was being served, from [::1], at the same moment.
    """
    from typer.testing import CliRunner

    from houston import cli, runner
    from houston import tls as tlsmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(runner.host, "docker_available", lambda **k: True)

    asked: list[str] = []

    def fake_verify(host, port, **kw):
        asked.append(host)
        if host == "127.0.0.1":            # the squatter: a different Traefik
            return {"serving": True, "fallback": True,
                    "issuer": "CN = TRAEFIK DEFAULT CERT",
                    "subject": "CN = TRAEFIK DEFAULT CERT", "dates": "", "names": [],
                    "trusted": False, "trusted_via_ca": False, "error": ""}
        return {"serving": True, "fallback": False,
                "issuer": "CN = houston local CA", "subject": "CN = t1.example.com",
                "dates": "notAfter=Nov 23 2026", "names": ["t1.example.com"],
                "trusted": True, "trusted_via_ca": True, "error": ""}
    monkeypatch.setattr(tlsmod, "verify", fake_verify)

    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "::1" in asked, f"the other loopback family was never tried: {asked}"
    assert "houston local CA" in (r.output or ""), r.output
    assert "TRAEFIK DEFAULT CERT" not in (r.output or ""), \
        "another program's placeholder was reported as this workspace's certificate"


def test_tls_status_still_reports_a_placeholder_when_every_family_serves_one(
        tmp_path, monkeypatch):
    """The counterpart: if nothing is serving the real certificate then the
    placeholder IS the finding, and must not be hidden by the family sweep."""
    from typer.testing import CliRunner

    from houston import cli, runner
    from houston import tls as tlsmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(runner.host, "docker_available", lambda **k: True)
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **k: {
        "serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT",
        "subject": "CN = TRAEFIK DEFAULT CERT", "dates": "", "names": [],
        "trusted": False, "trusted_via_ca": False, "error": ""})
    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "TRAEFIK DEFAULT CERT" in (r.output or ""), r.output
