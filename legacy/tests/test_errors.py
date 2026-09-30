"""`houston.errors`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import (
    _await_finish, _dns_env, _kube_tls_env, _legacy_home, _local_spec, _mem, _req,
    _svc, _svc_reader
)
import pytest


def test_error_http_status_mapping():
    assert errors.ValidationError.http_status == 400
    assert errors.ConflictError.http_status == 409
    assert errors.NotFoundError.http_status == 404
    assert errors.NotReadyError.http_status == 409
    assert errors.DockerError.http_status == 502
    assert issubclass(errors.ValidationError, errors.ReproError)


def test_require_docker_raises_when_down(monkeypatch):
    """An absent engine is a PREFLIGHT failure, not a "still coming up" one.

    It used to raise NotReadyError, which is exit 5 / HTTP 409 and means "poll
    again" -- advice that can never succeed, because polling does not start
    Docker. The caller has to fix their environment, so ENGINE_UNAVAILABLE:
    exit 3, HTTP 502, the dependency underneath is not there.

    Asserted on all three faces of the taxonomy, because each one is consumed by
    a different front-end and they have drifted apart before.
    """
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: False)
    with pytest.raises(errors.DockerError) as caught:
        lc.require_docker()
    assert caught.value.code == "ENGINE_UNAVAILABLE"
    assert caught.value.exit_code == 3          # CLI: fix it, do not retry
    assert caught.value.http_status == 502      # web: upstream dependency is down
    # And specifically NOT the "poll again" answer it used to give.
    assert not isinstance(caught.value, errors.NotReadyError)
    assert errors.NotReadyError.exit_code == 5


def test_a_domain_failure_exits_with_its_own_code_not_a_flat_one(monkeypatch, tmp_path):
    """Every failure used to exit 1, so a script could tell that something went
    wrong but never what — a workspace still booting and one that is known dead
    were indistinguishable without parsing English.

    Each error class now carries its own exit code and `errors.EXIT_CODES`
    publishes the map. Asserted through the real CLI, because the value that
    matters is the one the process actually returns.
    """
    from typer.testing import CliRunner

    from houston import cli, errors
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    cli_runner = CliRunner()

    cases = [
        (errors.NotFoundError("no such repro"), 4, "not_found"),
        (errors.ValidationError("bad value"), 2, "usage"),
        (errors.ConflictError("name taken"), 8, "conflict"),
        (errors.NotReadyError("still booting"), 5, "not_ready"),
        (errors.DockerError("engine is down"), 3, "preflight"),
    ]
    for exc, want, label in cases:
        def boom(*_a, _exc=exc, **_kw):
            raise _exc
        # resolve_name is the first service call every name-taking command makes,
        # so it is the seam that proves the handler, not the command.
        monkeypatch.setattr(lc.naming, "resolve_name", boom)
        res = cli_runner.invoke(cli.app, ["info", "--name", "x"])
        assert res.exit_code == want, (
            f"{type(exc).__name__} exited {res.exit_code}, expected {want}")
        assert errors.EXIT_CODES[want] == label

    # The taxonomy is the only place a code is decided, and it stays published.
    assert errors.EXIT_CODES[0] == "ok"
    assert errors.NotFoundError.exit_code == 4
    # ui.die keeps its old default, so every non-domain caller is unchanged.
    from houston import ui
    import inspect
    assert inspect.signature(ui.die).parameters["exit_code"].default == 1


def test_resolve_name_errors(monkeypatch):
    monkeypatch.setattr(lc.runner.paths, "exists", lambda n: False)
    with pytest.raises(errors.NotFoundError):
        lc.resolve_name("ghost")
    monkeypatch.setattr(lc.config, "load_config", lambda *a, **k: {})
    with pytest.raises(errors.ValidationError):
        lc.resolve_name("")      # no name, no default


def test_pick_host_port_out_of_range(monkeypatch):
    class P:
        instances = 3      # needs a 4-port block
    with pytest.raises(errors.ValidationError):
        lc.pick_host_port(65535, P(), exclude="")    # block runs past 65535


def test_job_reproerror_keeps_its_kind_on_the_wire():
    from houston.web import jobs as J

    def boom(emit):
        raise errors.NotFoundError("no such repro")

    job = J.JobManager().submit("t", boom)
    _await_finish(job)
    assert job.status == "error" and job.error_kind == "NotFoundError"
    evs, _done, _n = job.snapshot(0)
    assert evs[-1]["data"]["kind"] == "NotFoundError"


def test_a_domain_without_an_email_names_both_ways_to_give_one(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    with pytest.raises(errors.ValidationError) as ei:
        lc._resolve_tls(_req(domain="rc1.example.com"), "x", "")
    msg = str(ei.value)
    assert "--email" in msg and "config set acme.email" in msg


def test_unrecognised_credentials_are_refused_not_silently_ignored(tmp_path,
                                                                   monkeypatch):
    """Falling back to tlsalpn would ignore a file the user deliberately created."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _dns_env(tmp_path, "SOME_UNKNOWN_THING=x\n")
    with pytest.raises(errors.ValidationError) as ei:
        lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert "config set acme.dns_provider" in str(ei.value)


# These five assert PreflightError, not NotReadyError. errors.py always documented
# capacity that way -- "capacity shortfalls ... use this" -- while the code raised
# NotReadyError, which is exit 5 and means "still unknown, poll again". Polling does
# not free memory, so exit 5 told a script to retry something retrying cannot fix.
# Same argument that moved `require_docker` off exit 5; HTTP status is 409 either way.
def test_a_workspace_is_refused_when_the_host_cannot_hold_it(monkeypatch):
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=1000)      # 100 MB usable after the reserve
    with pytest.raises(errors.PreflightError) as exc:
        lc.check_capacity(lc.CreateReq(version="8.5.1"))
    assert "not enough memory" in str(exc.value)


def test_the_refusal_says_what_to_stop_and_how(monkeypatch):
    """"Out of memory" with no next step just moves the problem to the operator."""
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=1000)
    with pytest.raises(errors.PreflightError) as exc:
        lc.check_capacity(lc.CreateReq(version="8.5.1"))
    msg = str(exc.value)
    assert "houston stop" in msg and "--force" in msg
    assert "NO SWAP" in msg, "no swap means no buffer at all; say so"


def test_the_guard_would_have_stopped_the_incident(monkeypatch):
    """The REAL numbers from the host that died: 10024 MB total, 3350 MB
    available, no swap, and a seventh stack about to start.

    A fixed 1 GB reserve waved this exact configuration through when I tested it
    -- the box OOMed while MemAvailable still read 3.3 GB, because the memory that
    kills a host is what already-admitted workspaces take LATER. A proportional
    reserve refuses it.
    """
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, total_mb=10024, available_mb=3350, swap_mb=0)
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1"), "multi-instance")


def test_a_failed_recreate_never_destroys_data_that_down_promised_to_keep(
        monkeypatch, tmp_path):
    """The most damaging defect on this branch, and it was caused by a fix.

    The rollback added for failed creates deletes the namespace -- correct when this
    call created it, catastrophic over a namespace `down` had kept. Proven live: a
    marker document written before `down` was GONE after a failed `up`, because the
    rollback took the namespace and the PVC with it. `down` had printed "the
    namespace and its PersistentVolumeClaim are kept" moments earlier.

    A failure may only undo what the same call did. Deleting retained data is what
    `down --volumes` is for -- asked for deliberately, behind a confirmation.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.cluster, "ensure_cluster", lambda **kw: k8s.CONTEXT)
    monkeypatch.setattr(k8s.chart, "ensure_repo", lambda **kw: None)
    monkeypatch.setattr(k8s.chart, "resolve_chart_version", lambda *a, **kw: "7.0.2")
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **kw: k8s.Preflight(
        cluster_reachable=True, default_storage_class="standard"))
    monkeypatch.setattr(k8s.namespace, "ensure_namespace", lambda n, **kw: f"houston-{n}")
    monkeypatch.setattr(k8s.release, "apply", lambda *a, **kw: None)
    monkeypatch.setattr(k8s.replicaset, "init_replica_set", lambda **kw: None)
    monkeypatch.setattr(k8s.operator, "ensure_operator", lambda **kw: None)
    monkeypatch.setattr(k8s.operator, "wait_for_mongodb", lambda **kw: None)
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    monkeypatch.setattr(k8s.release, "install", lambda **kw: (_ for _ in ()).throw(
        errors.CreateFailedError("helm exploded")))
    resolved = type("R", (), {"rc_version": "8.6.1", "mongo_tag": "8.0",
                              "rc_image": "img", "oplog": False})()

    deleted: list = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: (
        deleted.append(" ".join(argv)) if "delete namespace" in " ".join(argv) else None)
        or __import__("subprocess").CompletedProcess(argv, 0, "", ""))

    # The namespace was ALREADY there -- a re-create after `down`.
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda *a, **kw: ["houston-k"])
    with pytest.raises(errors.CreateFailedError):
        k8s.create_workspace(name="k", resolved=resolved, host_port=3010,
                             microservices=False)
    assert not deleted, "the rollback destroyed a namespace it did not create"

    # A genuinely new namespace IS cleaned up, or a failed create leaks something
    # `list` cannot show.
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda *a, **kw: [])
    with pytest.raises(errors.CreateFailedError):
        k8s.create_workspace(name="k", resolved=resolved, host_port=3010,
                             microservices=False)
    assert deleted, "a namespace this call created was left behind"


def test_a_cluster_that_could_not_be_asked_is_not_a_cluster_without_an_ingress(monkeypatch):
    """The module's oldest rule, at a new call site.

    Returning None for a refused read would make "your cluster has no ingress
    controller" the message for an expired credential, a wrong context or an
    unreachable API server -- and send the reader to install something they already
    have. `Answer.require` is what refuses to guess.
    """
    from houston.services import k8s

    _svc_reader(monkeypatch, [], rc=1,
                stderr="Error in configuration: context was not found")
    with pytest.raises(errors.DockerError) as exc:
        k8s.ingress_endpoint("nope")
    assert "refusing to guess" in str(exc.value)


def test_two_candidate_ingresses_are_reported_rather_than_guessed(monkeypatch):
    """Kubernetes does not link an IngressClass to the Service that serves it -- the
    class names a controller string and nothing else. So with two reachable Services
    on :443 there is no answer, and picking the first would work on every cluster
    anybody tests and silently pass one workspace's TLS to the wrong ingress on the
    cluster where it mattered."""
    from houston.services import k8s

    _svc_reader(monkeypatch, [
        _svc("kube-system", "traefik", "LoadBalancer", address="172.16.0.2"),
        _svc("ingress-nginx", "controller", "LoadBalancer", address="172.16.0.3"),
    ])
    with pytest.raises(errors.ConflictError) as exc:
        k8s.ingress_endpoint("default")
    assert "traefik" in str(exc.value) and "controller" in str(exc.value)
    assert "port-forward" in str(exc.value), "say what to do instead"


def test_https_on_kubernetes_will_not_send_the_ca_key_to_a_remote_cluster(monkeypatch):
    """A `ca` ClusterIssuer means houston's CA PRIVATE KEY in a cluster Secret.

    `tls_local.py` says what that key is: it "can mint a certificate for any name the
    browser will trust". On this machine's own cluster that is the same trust boundary
    as the box, which already holds the key at 0600. On a managed cluster it is not,
    and there is a better answer that needs no CA at all.

    An `AuthorityGateError`, not a validation failure: the input is fine and the
    environment is fine, and what is missing is a decision houston is not entitled
    to make.
    """
    plan = _kube_tls_env(monkeypatch, distribution="eks")
    with pytest.raises(errors.AuthorityGateError) as exc:
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)
    assert "CA private key" in str(exc.value)
    assert "--domain" in str(exc.value), "name the alternative that needs no CA"
    # Unknown must not read as local: the question is whether a key may leave the box.
    plan = _kube_tls_env(monkeypatch, distribution="")
    with pytest.raises(errors.AuthorityGateError):
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)


def test_https_on_kubernetes_refuses_when_nothing_can_route_to_the_name(monkeypatch):
    """An ingress CLASS with no reachable Service is a controller nothing outside the
    cluster can reach. The workspace would install, the Ingress would exist, the
    certificate would issue, and the name would answer nothing."""
    plan = _kube_tls_env(monkeypatch, endpoint=None)
    with pytest.raises(errors.PreflightError) as exc:
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)
    assert "no Service publishing :443" in str(exc.value)


def test_two_populated_state_directories_are_refused_rather_than_merged(tmp_path,
                                                                       monkeypatch):
    """Merging two state directories means choosing which `users` file wins, and no
    safe answer exists -- so it is a typed refusal that names both paths."""
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)
    (tmp_path / ".houston").mkdir()
    (tmp_path / ".houston" / "users").write_text("# houston GUI accounts.\nbob\tx\n")

    with pytest.raises(errors.ConflictError) as caught:
        migratesvc.migrate()
    assert ".rc-repro" in str(caught.value) and ".houston" in str(caught.value)
    assert (tmp_path / ".rc-repro").exists(), "a refusal must not have moved anything"


def test_ensure_ingress_will_not_provision_a_cloud_load_balancer_implicitly(monkeypatch):
    """The chart's Service is a LoadBalancer, and on a managed cluster that provisions
    a REAL load balancer -- billable, created implicitly, in somebody's account.
    `.docs/design/kubernetes-cluster-model.md` already decided that one: never create a
    billable cloud resource implicitly. So a remote cluster is told what to run."""
    from houston.services import k8s

    import subprocess as sp

    monkeypatch.setattr(k8s.capabilities, "ingress_classes", lambda ctx: [])
    # Only a HELM call is forbidden. Reads are fine -- deciding locality is itself a
    # read, and a stub that refuses every subprocess would fail on the question rather
    # than on the answer.
    def no_helm(argv, **kw):
        assert argv[0] != "helm", f"must not install: {argv}"
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", no_helm)
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_ingress(context="prod", distribution="eks")
    assert "not on this machine" in str(exc.value)
    assert "helm install traefik" in str(exc.value), "say what to run instead"
    # Unknown locality must not read as local: the question is whether to spend money.
    monkeypatch.setattr(k8s.context, "distribution_of", lambda ctx: "")
    with pytest.raises(errors.PreflightError):
        k8s.ensure_ingress(context="prod", distribution="")


def test_the_skill_states_only_numbers_the_build_still_confirms():
    """The skill said `standard` seeds 283 messages. The plan builds 287.

    Nothing caught it because a number in prose has no reader. `capabilities`
    publishes the profile NAMES and not their shapes, so this file was the only
    statement of the counts anywhere -- and it was wrong, in the one document a
    caller is told to trust before it has run anything. The registry walks
    elsewhere in this suite exist for exactly this shape of defect; the three
    claims below are the ones in the skill that a build change can falsify, so
    they get the same treatment as `ROUTE_ROLES` and `PHASES`.
    """
    import re

    from houston import errors, presets, seed
    from houston.services import skill

    text = skill.packaged().read_text(encoding="utf-8")

    # 1. The seed shape, as a sentence the file actually contains.
    m = re.search(r"`standard` is (\d+) rooms, (\d+) messages, (\d+) threads "
                  r"across (\d+) users", text)
    assert m, "the skill no longer states the `standard` profile's shape"
    plan = seed.plan_from("standard")
    assert [int(g) for g in m.groups()] == [len(plan.rooms), plan.total_messages,
                                           plan.total_replies, plan.users], (
        "the skill's `standard` numbers no longer match what seed.plan_from builds")

    # 2. The preset catalogue, both directions. A name the file invents is a caller
    #    sent to a refusal; a preset nobody documented is a feature with no door.
    #    `multi-instance` is the deliberate exception -- it is the deployment axis
    #    under its old name, and the file explains it as that rather than listing it.
    sentence = text.split("`capabilities.presets` lists what this build has:")[1]
    listed = set(re.findall(r"`([a-z0-9_-]+)`", sentence.split(".")[0]))
    catalog = {pre.name for pre in presets.list_presets()}
    assert listed <= catalog, f"the skill names presets that do not exist: {listed - catalog}"
    assert catalog - listed == {"multi-instance"}, (
        f"undocumented preset(s): {catalog - listed - {'multi-instance'}}")
    assert "--preset multi-instance" in text

    # 3. The exit-code table callers are told to branch on. `6` is in EXIT_CODES and
    #    nothing raises it, so the file names it as reserved instead of as a rule.
    bullets = {int(d) for d in re.findall(r"^   - `(\d)` ", text, re.M)}
    assert bullets == set(errors.EXIT_CODES) - {0}, (
        f"the skill's exit-code table and errors.EXIT_CODES disagree: "
        f"{bullets ^ (set(errors.EXIT_CODES) - {0})}")
    # 6 IS a bullet now. It used to be excluded here and described in the file as
    # reserved "which nothing in this build raises", and both were wrong:
    # AuthorityGateError.advertised is True and it is raised in three places. Step
    # 0.12 corrected the file, so this walk stopped licensing the claim.
    assert errors.AuthorityGateError.advertised, "6 is unadvertised; the bullet is wrong"

    # 4. The sample envelope carries a real version, in the one file whose closing
    #    section is about telling a caller whether it is current. Pinning it here is
    #    what lets it stay a real value instead of drifting into a fossil -- it was
    #    four minor versions behind when this walk was written.
    from houston import __version__
    assert f'"houston_version":"{__version__}"' in text, (
        "the skill's sample envelope names a version this build is not")


def test_resolve_name_rejects_a_name_that_is_not_a_repro(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import errors
    from houston.services import lifecycle as lcsvc
    # The name becomes a filesystem path and a compose project name, so nothing
    # unsafe may come back. Resolution now SANITIZES rather than validating --
    # creation always did, and the two disagreeing is what stopped `--name` round
    # tripping -- so the guarantee is that these resolve to nothing, not that they
    # raise one particular error: 'Has-Caps' is a legal request for 'has-caps'.
    for bad in ("../../etc", "..", "Has-Caps", "with space", "semi;colon",
                "../" * 20 + "etc", "a/b", "x\x00y"):
        try:
            got = lcsvc.resolve_name(bad)
        except errors.ReproError:
            continue
        raise AssertionError(f"{bad!r} resolved to {got!r}; expected a refusal")
