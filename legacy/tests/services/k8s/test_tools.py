"""`houston.services.k8s.tools`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _fake_run
import pytest
import subprocess


def test_tool_versions_parse_the_three_formats_the_tools_actually_print():
    """Each tool spells its version differently, and all three strings below are
    real output from this machine. A parser that only handled one would report a
    present tool as unknown and, with a floor to check, refuse to proceed."""
    from houston.services import k8s

    assert k8s._parse_version("kind v0.32.0 go1.26.3 linux/amd64") == (0, 32, 0)
    assert k8s._parse_version("Client Version: v1.36.3") == (1, 36, 3)
    assert k8s._parse_version("v4.2.3+g43e8b7f") == (4, 2, 3)
    assert k8s._parse_version("something unparseable") == ()


def test_an_unparseable_version_is_not_treated_as_too_old():
    """A distro may print something this does not recognise. Refusing to proceed
    over an unrecognised version string is worse than trying: the binary is there,
    and the floor exists to catch a genuinely ancient one, not to gate on parsing."""
    from houston.services import k8s

    assert k8s.Tool(name="helm", path="/usr/bin/helm", raw="weird").new_enough
    assert not k8s.Tool(name="helm", path="/usr/bin/helm", version=(2, 17)).new_enough
    assert k8s.Tool(name="helm", path="/usr/bin/helm", version=(3, 0)).new_enough
    assert not k8s.Tool(name="helm").present


def test_a_cloud_provisioning_tool_cannot_switch_off_local_provisioning(monkeypatch):
    """`can_provision` is an `all()`, so the registry it reads decides who it breaks.

    Putting a cloud tool in the same dict as kind would make the property False on
    every box that has kind and not that tool -- and it is not a cosmetic answer:
    `preflight()` gates its `cluster_exists`/`other_clusters` probe on it, and the GUI
    create dialog reads it to decide whether to say "no cluster yet" and to label the
    runtime card "Kubernetes (kind)". A box that can build a kind cluster would have
    stopped saying so because it had no AWS tooling installed.
    """
    from houston.services import k8s

    kind_only = {"kind": k8s.Tool(name="kind", path="/usr/bin/kind", version=(0, 32)),
                 "kubectl": k8s.Tool(name="kubectl", path="/usr/bin/kubectl",
                                     version=(1, 36)),
                 "helm": k8s.Tool(name="helm", path="/usr/bin/helm", version=(4, 2))}

    monkeypatch.setattr(k8s.tuning, "CLOUD_PROVISION_TOOLS", {"eksctl": (0, 195)})
    pre = k8s.Preflight(tools=dict(kind_only))

    assert pre.can_provision is True, \
        "a cloud tool in the registry must not disown a box that has kind"
    assert pre.can_provision_cloud is False, \
        "and the cloud answer is its own question"

    # With the cloud tool actually present, both are true and neither shadows the other.
    withcloud = dict(kind_only)
    withcloud["eksctl"] = k8s.Tool(name="eksctl", path="/usr/bin/eksctl",
                                   version=(0, 200))
    assert k8s.Preflight(tools=withcloud).can_provision_cloud is True

    # An EMPTY cloud registry is False, not True. `all()` over nothing is True, and
    # "no cloud tooling compiled in" must never read as "yes, this box builds EKS".
    monkeypatch.setattr(k8s.tuning, "CLOUD_PROVISION_TOOLS", {})
    assert k8s.Preflight(tools=dict(kind_only)).can_provision_cloud is False


def test_a_tool_probed_with_the_wrong_flag_passes_its_floor_silently(monkeypatch):
    """Two correct behaviours combine into a version floor that never fires.

    `tool()`'s fallback asks `<name> --version`. `_parse_version` returns () when it
    cannot read the output, and `Tool.new_enough` returns True on an empty version --
    deliberately, so an unparseable version never blocks a tool that works. Together
    they mean a tool that does not accept `--version` is reported present, new enough,
    and unversioned. `eksctl` is cobra-based and spells it `eksctl version`.
    """
    from houston.services import k8s

    seen: list[list[str]] = []

    def fake_run(argv, **kw):
        seen.append(list(argv))
        if argv[1:] == ["--version"]:            # what cobra does with an unknown flag
            return subprocess.CompletedProcess(
                argv, 1, "", 'unknown flag: --version')
        return subprocess.CompletedProcess(argv, 0, "0.195.0", "")

    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/eksctl")
    monkeypatch.setattr(k8s.kube, "run", fake_run)

    found = k8s.tool("eksctl")
    assert seen[-1] == ["eksctl", "version"], \
        f"probed with {seen[-1]}, which cobra refuses"
    assert found.version == (0, 195, 0), found.raw

    # And the hazard itself, stated so the reason for the mapping is not lost: an
    # unparsed version is not a failed floor, it is a PASSED one.
    assert k8s.Tool(name="x", path="/x", version=()).new_enough is True


def test_a_version_floor_says_something_true_about_where_it_came_from(monkeypatch,
                                                                     tmp_path):
    """`doctor` cited the official Rocket.Chat guide for every floor it enforces.

    It is unverifiable for all of them. Launchpad's prerequisites name `kubectl` and
    `eksctl` with no versions at all, and never mention `kind`. So somebody told their
    kind was "older than 0.20, the floor the official Rocket.Chat guide requires" was
    being sent to a document that does not contain the requirement -- and the same
    sentence would have been produced for any cloud tool added to the registry.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    old = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2)),
        "kind": k8s.Tool(name="kind", path="/kd", version=(0, 1)),   # below its floor
    })
    monkeypatch.setattr(k8s.probe, "preflight", lambda context="": old)

    msgs = [r["message"] for r in doctorsvc.run_checks()["checks"]]
    hit = [m for m in msgs if "kind" in m and "older than" in m]
    assert hit, msgs
    assert "official Rocket.Chat guide" not in hit[0], \
        "the guide does not mention kind, let alone a version of it"
    assert "extraPortMappings" in hit[0], \
        "the floor should say what actually decided it"


def test_preflight_stops_before_asking_a_cluster_that_is_not_there(monkeypatch):
    """Ordering matters: asking an absent API server for storage classes would time
    out, and the timeout would be reported as "no storage" -- a wrong answer that
    sends someone to fix the wrong thing."""
    from houston.services import k8s

    asked = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        asked.append(" ".join(argv))
        if "get clusters" in " ".join(argv):
            return sp.CompletedProcess(argv, 0, "kind\n", "")
        return sp.CompletedProcess(argv, 0, "v1.0.0", "")

    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", spy)
    pre = k8s.preflight()
    assert pre.cluster_exists is False
    assert pre.other_clusters == ["kind"]
    assert not any("storageclass" in a for a in asked), \
        "it asked an absent cluster for storage"


def test_doctor_stays_quiet_about_kubernetes_when_nobody_is_using_it(monkeypatch, tmp_path):
    """A doctor that reports FAIL for a feature you are not using teaches people to
    ignore its failures. With no tools and no Kubernetes workspace, the whole
    subject is one informational line -- not five rows of absence."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda _t: "")
    report = doctor.run_checks()
    kube = [r for r in report["checks"] if "ubernetes" in r["message"]]
    assert len(kube) == 1, f"expected one line, got {[r['message'] for r in kube]}"
    assert kube[0]["status"] == "ok"
    assert "unaffected" in kube[0]["message"]


def test_a_cluster_with_no_default_storageclass_is_reported(monkeypatch, tmp_path):
    """The guide opens with this warning: local distributions "often ship without a
    storage provisioner enabled". The failure it causes is silent -- a PVC stays
    Pending forever and nothing in the output names storage."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    report = doctor.run_checks()
    sc = [r for r in report["checks"] if "StorageClass" in r["message"]]
    assert len(sc) == 1 and sc[0]["status"] == "warn", [r["message"] for r in report["checks"]]
    assert "Pending" in sc[0]["message"], "it must name the symptom, not just the cause"


def test_a_stopped_docker_is_not_reported_as_a_missing_cluster(monkeypatch, tmp_path):
    """`kind` talks to Docker. With Docker stopped, `kind get clusters` exits
    non-zero -- which reads as an empty list if only stdout is consulted, and
    "your cluster does not exist" is then a WRONG answer that sends someone to
    create a cluster that is already there.

    The two are kept apart: answered-no and could-not-ask.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (1, ""),          # non-zero: Docker is down
        "version": (0, "v9.9.9"),
    }))
    found, why = k8s.clusters()
    assert found == [] and why, "the reason must survive, not be flattened to []"

    report = doctor.run_checks()
    msgs = [r["message"] for r in report["checks"]]
    assert any("Could not tell whether cluster" in m for m in msgs), msgs
    assert not any("does not exist" in m for m in msgs), \
        "it claimed the cluster is absent when it merely could not ask"


def test_kubernetes_works_without_kind_because_kind_only_creates_clusters(monkeypatch):
    """kind is needed to PROVISION a cluster, never to USE one.

    Namespaces, helm releases, PVCs, port-forwards and exec are plain Kubernetes.
    They behave the same on k3s, minikube, Docker Desktop or a remote cluster, so a
    box with kubectl and helm and no kind is fully usable -- it just cannot be
    handed a cluster, it has to be pointed at one.

    The first cut of this module returned early when kind was absent, which made a
    perfectly good k3s box look like it had no Kubernetes at all.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.tools, "which", lambda t: "" if t == "kind" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "config current-context": (0, "k3s-default\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "local-path",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    pre = k8s.preflight()
    assert pre.tools_ready, "kubectl + helm is all that USING Kubernetes needs"
    assert not pre.can_provision, "without kind it cannot create a cluster"
    assert pre.missing_tools == [], "a missing kind is not a missing requirement"
    assert pre.context == "k3s-default", "it fell back to the configured cluster"
    assert pre.provider == k8s.PROVIDER_EXTERNAL
    assert pre.cluster_reachable and pre.usable
    assert pre.default_storage_class == "local-path"


def test_doctor_names_both_ways_to_get_a_cluster_when_there_is_none(monkeypatch, tmp_path):
    """kubectl and helm but nothing to point them at. Naming only kind would be
    wrong -- pointing at an existing k3s or Docker Desktop cluster is equally
    valid, and for most people already done."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: "" if t == "kind" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "config current-context": (1, ""),
        "version": (0, "v9.9.9"),
    }))
    msgs = [r["message"] for r in doctor.run_checks()["checks"]]
    hit = [m for m in msgs if "No Kubernetes cluster configured" in m]
    assert len(hit) == 1, msgs
    assert "kind" in hit[0] and "k3s" in hit[0], "both routes must be named"


def test_doctor_names_the_cluster_up_would_actually_use(monkeypatch, tmp_path):
    """A box with BOTH kind and k3s. `doctor` resolved the cluster itself -- kind's
    if one existed, else whatever kubectl pointed at -- and `up` asked
    `plan_cluster`, which creates houston's own whenever kind is installed. With
    kind present but no cluster yet and k3s running, the two disagreed: the report
    said "Using your cluster 'default' (k3s)" and `up` went and built a kind
    cluster. A preflight whose whole job is predicting a boot cannot be a second
    opinion about it."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, "\n"),            # kind installed, no cluster yet
        "config current-context": (0, "default\n"),   # ...but k3s is up and active
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))

    plan = k8s.plan_cluster()
    pre = k8s.preflight()
    assert pre.context == plan.context, "doctor and up must name the same cluster"
    assert pre.will_create is plan.create

    msgs = [r["message"] for r in doctor.run_checks()["checks"]]
    assert not any("Using your cluster 'default'" in m for m in msgs), \
        "reported a cluster that up would not touch"
    assert any(f"No cluster yet — {k8s.CLUSTER_NAME!r} is created on first use" in m
               for m in msgs), msgs
    # ...and the one being set aside is still named, or the next question is why
    # houston is building a second cluster next to a working one.
    assert any("will NOT be used" in m and "'default'" in m for m in msgs), msgs


def test_missing_storage_is_a_refusal_because_nothing_would_ever_log_it():
    """The reason this cannot be left to the logs.

    With no provisioner the PVC stays Pending, the pod stays Pending, and
    Rocket.Chat NEVER STARTS -- so there are no Rocket.Chat logs to find it in.
    Left to run it costs the full readiness timeout and then reports "Rocket.Chat
    did not become ready", which blames the one component that is innocent and
    sends someone to debug it.

    Same reasoning as the mongo/kernel gate: there is no case where continuing
    works, so a warning would only be a slower failure.
    """
    from houston.services import k8s

    none_at_all = k8s.Preflight(context="c", cluster_reachable=True)
    msg = k8s.storage_blocker(none_at_all)
    assert msg, "an unprovisioned cluster must be refused"
    assert "never start" in msg, "it must name the symptom"
    assert "logs" in msg, "and say why the logs will not show it"

    # A cluster with classes but no DEFAULT is the subtler half, and fails the
    # same way -- so it gets the command that fixes it.
    no_default = k8s.Preflight(context="c", cluster_reachable=True,
                               storage_classes=["fast", "slow"])
    msg2 = k8s.storage_blocker(no_default)
    assert "none is marked default" in msg2
    assert "kubectl patch storageclass" in msg2, "name the fix, not just the fault"

    # Provisioned: silent.
    ok = k8s.Preflight(context="c", cluster_reachable=True,
                       storage_classes=["standard"], default_storage_class="standard")
    assert k8s.storage_blocker(ok) == ""


def test_storage_is_not_reported_for_a_cluster_nobody_could_reach():
    """Reporting "no StorageClass" for an unreachable cluster is the same wrong
    answer as reporting an absent cluster for a stopped Docker: it sends someone
    to fix storage when the problem is that nothing answered."""
    from houston.services import k8s

    unreachable = k8s.Preflight(context="c", cluster_reachable=False)
    assert k8s.storage_blocker(unreachable) == ""


def test_doctor_never_warns_about_ingress(monkeypatch, tmp_path):
    """This used to assert `doctor` did not MENTION ingress at all, on the reasoning that
    it cannot know whether you are about to ask for `--domain` and most workspaces never
    do. That reasoning was about not nagging, and it still holds -- but silence turned out
    to be the wrong way to keep it: on a cluster that already has an ingress controller
    (k3s ships Traefik) the report left a reader unable to see the one thing that
    distinguishes their cluster from a kind one.

    So it is reported as a FACT and never as a warning. Severity still belongs to whatever
    needs it, which is `ensure_ingress` adopting or installing one at create time.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "standard",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get ingressclass": (0, ""),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    rows = doctor.run_checks()["checks"]
    ingress = [r for r in rows if "ingress" in r["message"].lower()]
    # SEVERITY, not a row count. Two rows mention it now: the fact itself, and the
    # `kubernetes-https` summary saying which shape the box is in. Asserting a count
    # made this test about the report's length rather than about nagging, which is the
    # property it exists to protect.
    assert ingress, "the fact is worth reporting — k3s having one is what tells that "\
                    "cluster apart from a kind one"
    assert {r["status"] for r in ingress} == {"ok"}, \
        "an absent ingress controller is not a fault"
    assert "kubernetes-ingress" in {r["check"] for r in ingress}
    assert "port-forward" in ingress[0]["message"], \
        "and it says why its absence does not matter"
    # Nothing anywhere in the report escalates over it.
    assert not any(r["status"] in ("warn", "fail") and "ingress" in r["message"].lower()
                   for r in rows)


def test_ensure_cluster_refuses_without_kind_and_names_the_alternative(monkeypatch, tmp_path):
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda _t: "")
    with pytest.raises(errors.PreflightError) as caught:
        k8s.ensure_cluster()
    assert "point kubectl at a cluster you already have" in str(caught.value)
    assert caught.value.exit_code == 3


def test_deleting_a_cluster_that_is_not_there_is_not_an_error(monkeypatch, tmp_path):
    """`prune` calls this unconditionally; a missing cluster is the state it wanted."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({"get clusters": (0, "somebody-else\n")}))
    assert k8s.delete_cluster() is False


def test_the_flag_that_undoes_a_failed_install_is_named_for_the_helm_installed():
    """**`--atomic` does not exist in helm 4** -- it is `--rollback-on-failure`.

    So the standard advice for a wedged release would itself fail on a box running
    helm 4, and an unrecognised flag turns a working install into a broken one.
    Verified against the 4.2.3 on this machine: `helm upgrade --help` lists
    `--rollback-on-failure` and no `--atomic`.
    """
    from houston.services import k8s

    class _T:
        present, version = True, ()

    def at(ver):
        t = _T(); t.version = ver; return t

    import unittest.mock as m
    with m.patch.object(k8s.tools, "tool", lambda n: at((4, 2, 3))):
        assert k8s.helm_rollback_on_failure() == ["--rollback-on-failure"]
    with m.patch.object(k8s.tools, "tool", lambda n: at((3, 14, 0))):
        assert k8s.helm_rollback_on_failure() == ["--atomic"]
    with m.patch.object(k8s.tools, "tool", lambda n: at(())):
        assert k8s.helm_rollback_on_failure() == [], \
            "an unknown helm gets no flag rather than a guessed one"


def test_doctor_is_silent_about_aws_until_aws_is_somebody_s_business(monkeypatch,
                                                                    tmp_path):
    """A Compose-and-kind box must not be padded with cloud complaints.

    The same reasoning as the one-line "Kubernetes not set up": a red line for a
    half-finished optional feature is how a report teaches people to ignore red lines.
    But on a cluster that IS EKS, `aws` is not optional -- the kubeconfig authenticates
    by shelling out to it -- so there it fails rather than warns.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks as ekssvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    nothing = ekssvc.CloudPreflight(
        tools={"aws": k8s.Tool(name="aws", path=""),
               "eksctl": k8s.Tool(name="eksctl", path="")},
        identity=ekssvc.Identity(), region="")
    monkeypatch.setattr(ekssvc.aws, "preflight", lambda: nothing)

    def rows(distribution: str) -> list[dict]:
        pre = k8s.Preflight(tools={
            "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
            "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))})
        pre.distribution = distribution
        monkeypatch.setattr(k8s.probe, "preflight", lambda context="": pre)
        return doctorsvc.run_checks()["checks"]

    assert not [r for r in rows("k3s") if r["check"] == "kubernetes-cloud"], \
        "a k3s box has no business being told about AWS"

    on_eks = [r for r in rows("eks") if r["check"] == "kubernetes-cloud"]
    assert on_eks, "a cluster that IS EKS must be told aws is missing"
    assert all(r["status"] == "fail" for r in on_eks), \
        "on EKS a missing `aws` is not a warning — every kubectl call fails without it"


def test_a_cloud_cluster_this_box_built_is_reported_even_with_no_aws_installed(
        monkeypatch, tmp_path):
    """A cluster does not stop billing because `aws` was uninstalled afterwards.

    Everything else AWS-shaped in `doctor` is behind a relevance gate — a Compose box
    must not be padded with cloud complaints. This one is deliberately outside it,
    because the box with no cloud tooling is exactly the box most likely to have
    forgotten a cluster it built. It reads the local pointer rather than AWS, which is
    the whole reason the pointer exists: `doctor` has to be able to say this without a
    credential or a round trip.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/kubectl"
                        if t in ("kubectl", "helm") else "")
    pre = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))})
    monkeypatch.setattr(k8s.probe, "preflight", lambda context="": pre)

    assert not [r for r in doctorsvc.run_checks()["checks"]
                if r["check"] == "kubernetes-cloud-owned"], "nothing built, nothing said"

    eks.remember("rc-support", region="eu-west-1", account="123456789012")
    rows = [r for r in doctorsvc.run_checks()["checks"]
            if r["check"] == "kubernetes-cloud-owned"]
    assert len(rows) == 1, rows
    said = rows[0]["message"]
    assert "rc-support" in said and "eu-west-1" in said and "123456789012" in said, \
        "a warning that does not say WHICH cluster, where, or whose is unactionable"
    assert "cluster delete rc-support" in said, "and it has to say how to stop it"

    # And it goes when the cluster does.
    eks.forget("rc-support")
    assert not [r for r in doctorsvc.run_checks()["checks"]
                if r["check"] == "kubernetes-cloud-owned"]


def test_doctor_says_how_far_past_its_date_a_cluster_is(monkeypatch, tmp_path):
    """The sum involved is one somebody has stopped thinking about.

    Read from the local pointer rather than from AWS, which is the whole reason the
    pointer carries it: `doctor` has to be able to say this with no credential and no
    round trip, on the box most likely to have forgotten the cluster.

    Still a warning and never a failure. Nothing here deletes, and a report that fails
    on somebody's spending decision is a report that gets ignored.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))})
    monkeypatch.setattr(k8s.probe, "preflight", lambda context="": pre)

    def row_for(expires):
        for f in (tmp_path / "clusters").glob("*/cluster.json"):
            f.unlink()
        eks.remember("c", region="us-east-1", account="1", expires=expires)
        hits = [r for r in doctorsvc.run_checks()["checks"]
                if r["check"] == "kubernetes-cloud-owned"]
        assert len(hits) == 1, hits
        return hits[0]

    past = row_for("2020-01-01")
    assert "PAST the expiry" in past["message"]
    assert past["status"] == "warn", "spending is the operator's decision, not a gate"

    ahead = row_for(eks.expiry_date(30))
    assert "day(s) left" in ahead["message"] and "PAST" not in ahead["message"]

    # No expiry: still warned about -- it is still costing money -- but with nothing
    # said about a date it never had.
    none = row_for("")
    assert "billing" in none["message"]
    assert "expiry" not in none["message"] and "PAST" not in none["message"]


def test_doctor_reports_what_a_cluster_provides_the_same_way_on_every_distribution(
        monkeypatch, tmp_path):
    """The difference between kind and k3s is three capabilities -- ingress, load
    balancer, metrics -- and nothing in the report said so. A reader on a context called
    `default` was not even told it was k3s, and found out that `stats` works there by
    running it.

    All three are `ok` rows on purpose. A capability is a FACT; severity belongs to
    whatever needs it, and an absent ingress controller cannot affect a workspace reached
    by port-forward -- `ensure_ingress` is what adopts or installs one when something asks for a
    hostname. A doctor that warns about a feature you are not using teaches people to
    ignore its warnings.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def report_for(pre):
        monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **k: pre)
        monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/" + t)
        rows = doctor.run_checks()["checks"]
        return {r["check"]: r for r in rows if r["check"].startswith("kubernetes")}

    tools = {n: k8s.Tool(name=n, path="/usr/bin/" + n, version=(9, 9))
             for n in ("kubectl", "helm", "kind")}
    k3s = report_for(k8s.Preflight(
        tools=tools, cluster_reachable=True, context="default",
        provider=k8s.PROVIDER_EXTERNAL, distribution="k3s", node_count=1,
        architectures=["amd64"], default_storage_class="local-path",
        ingress_classes=["traefik"], metrics=True,
        loadbalancer="traefik has 172.16.0.2"))
    assert "k3s, 1 node, amd64" in k3s["kubernetes-cluster"]["message"]
    assert "traefik" in k3s["kubernetes-ingress"]["message"]
    assert "172.16.0.2" in k3s["kubernetes-loadbalancer"]["message"]
    assert "`houston stats` works here" in k3s["kubernetes-metrics"]["message"]
    assert all(k3s[c]["status"] == "ok" for c in
               ("kubernetes-ingress", "kubernetes-loadbalancer", "kubernetes-metrics"))

    kind = report_for(k8s.Preflight(
        tools=tools, cluster_reachable=True, cluster_exists=True, context=k8s.CONTEXT,
        provider=k8s.PROVIDER_KIND, distribution="kind", node_count=1,
        architectures=["amd64"], default_storage_class="standard"))
    assert "kind, 1 node, amd64" in kind["kubernetes-cluster"]["message"]
    # The same three subjects, answered the other way and still not a warning.
    assert "none installed" in kind["kubernetes-ingress"]["message"]
    assert "not confirmed" in kind["kubernetes-loadbalancer"]["message"]
    assert "refuses" in kind["kubernetes-metrics"]["message"]
    assert all(kind[c]["status"] == "ok" for c in
               ("kubernetes-ingress", "kubernetes-loadbalancer", "kubernetes-metrics"))
    # Storage is reported when it is THERE too, not only when it is missing.
    assert "standard (default)" in kind["kubernetes-storage"]["message"]


def test_the_edge_port_row_names_the_port_it_found_not_always_443(monkeypatch, tmp_path):
    """A cluster holding only :80 was reported as holding :443.

    That is not cosmetic: the reader is being told which challenge cannot complete
    and which port to give back. On the box this came from, `acme.challenge` was
    `http` -- so :80 was the whole problem and the report pointed at the other port.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(tools={
        n: k8s.Tool(name=n, path=f"/usr/bin/{n}", version=(9, 9, 9), raw="v9.9.9")
        for n in ("kubectl", "helm")})
    pre.context = "default"
    pre.cluster_reachable = False
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **k: pre)
    monkeypatch.setattr(k8s.context, "active_context", lambda: "default")
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, **kw: True)
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s.endpoints, "host_port_claim",
                        lambda ctx, **kw: k8s.PortClaim(
                            context=ctx, service="kube-system/traefik",
                            address="172.16.0.2", ports=[80]))

    from houston.services import edge as edgesvc
    monkeypatch.setattr(edgesvc.spec, "installed", lambda: True)
    monkeypatch.setattr(edgesvc.routes, "registered", lambda: ["w1"])
    monkeypatch.setattr(edgesvc.spec, "current", lambda: None)

    hit = [r for r in doctor.run_checks()["checks"]
           if r.get("check") == "kubernetes-edge-port"]
    assert hit, "a cluster holding :80 is still a cluster holding the edge's port"
    msg = hit[0]["message"]
    assert ":80" in msg, msg
    assert ":443" not in msg, "it does not hold :443, and saying so sends the reader wrong"
    assert "http-01" in msg, "name the challenge that cannot complete"
    # The patch has to name the service that was found, not a guessed one.
    assert "patch svc traefik" in msg, msg
    # The recurrence is the point: the patch is undone by the next k3s install.
    assert "--disable servicelb" in msg, msg


def test_the_create_claim_names_the_binary_that_makes_it_true(tmp_path, monkeypatch):
    """"No cluster yet — 'houston-local' is created on first use" said nothing about
    what would create it.

    Reported as confusing by someone who believed kind was not installed: the row
    promised a cluster and gave the reader no way to tell the claim was well-founded.
    It requires kind (`can_provision`), so naming the kind settles it either way.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 30), raw="v1.30.0"),
        "helm": k8s.Tool(name="helm", path="/h", version=(3, 14), raw="v3.14.0"),
        "kind": k8s.Tool(name="kind", path="/kd", version=(0, 32, 0),
                         raw="kind v0.32.0 go1.26.3 linux/amd64"),
    })
    pre.context = k8s.CONTEXT
    pre.will_create = True
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **kw: pre)
    monkeypatch.setattr(k8s.context, "active_context", lambda: "")

    hit = [r for r in doctor.run_checks()["checks"]
           if r.get("check") == "kubernetes-cluster"]
    assert hit, "the cluster row must still be reported"
    msg = hit[0]["message"]
    assert "created on first use" in msg, msg
    assert "by kind 0.32.0" in msg, "cite the binary, and the parsed version not the banner"
    assert "go1.26" not in msg, "the raw version banner is not a version"


def test_a_missing_helm_is_not_reported_as_an_unreachable_cluster(monkeypatch):
    """There is already a tools check for that, and two rows about one binary is how
    a reader learns to distrust both."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.tools, "which", lambda t: "" if t == "helm" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run",
                        lambda *a, **k: pytest.fail("must not run a missing helm"))
    assert k8s.helm_reachable("default") == ""


def test_doctor_fails_when_helm_cannot_reach_a_cluster_kubectl_can(monkeypatch,
                                                                  tmp_path):
    """FAIL, not warn: every Kubernetes create on this box is broken until it is
    fixed, and the tick doctor used to print beside it is what sent a reader looking
    at the chart instead of the kubeconfig."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "standard",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get ingressclass": (0, ""),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
        # THE ONE THAT DISAGREES.
        "helm list": (1, "Error: kubernetes cluster unreachable: x509: certificate "
                         "signed by unknown authority"),
    }))
    rows = doctor.run_checks()["checks"]
    hit = [r for r in rows if "helm cannot reach" in r["message"]]
    assert hit, [r["message"][:60] for r in rows]
    assert hit[0]["status"] == "fail", hit
    assert "kubectl can" in hit[0]["message"]
    assert "roll back" in hit[0]["message"]


def test_an_empty_cloud_record_beside_working_credentials_says_so_rather_than_nothing(
        monkeypatch, tmp_path):
    """Silence from the local pointer means one of two very different things.

    OBSERVED during an audit of this branch: an EKS cluster tagged `houston`, ACTIVE,
    expiring the next day, while the owner's `~/.houston/clusters/` did not exist at
    all -- so `doctor` on that box said nothing about it. The pointer is deliberately
    "best effort, never load-bearing", and CLAUDE.md tells anyone writing a script to
    `export HOUSTON_HOME=$(mktemp -d)`, so following this project's own instructions
    produces a create whose reminder is discarded.

    `doctor` is the command people run out of habit and `cluster list` is the one that
    actually asks AWS. Nothing routed the first to the second.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/" + t)
    monkeypatch.setattr(k8s.probe, "preflight", lambda context="": k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))}))
    ready = eks.CloudPreflight(
        tools={"aws": k8s.Tool(name="aws", path="/a", version=(2, 0)),
               "eksctl": k8s.Tool(name="eksctl", path="/e", version=(0, 200))},
        identity=eks.Identity(account="123456789012",
                              arn="arn:aws:iam::123456789012:user/support"),
        region="eu-west-1")
    assert ready.ready, "the double has to be a box that COULD build a cluster"
    monkeypatch.setattr(eks.aws, "preflight", lambda: ready)

    rows = [r for r in doctorsvc.run_checks()["checks"]
            if r["check"] == "kubernetes-cloud-owned"]
    assert len(rows) == 1, rows
    said = rows[0]["message"]
    assert rows[0]["status"] == "warn", "it is a spending decision, never a failure"
    assert "cluster list" in said, \
        "a report that names the gap and not the command that closes it is half a report"
    assert "not the same as there being none" in said

    # AND IT GOES QUIET THE MOMENT THERE IS A RECORD, because then the loop above says
    # the useful thing instead and repeating "I might not know" beside a named cluster
    # would teach the reader to skip both lines.
    eks.remember("rc-support", region="eu-west-1", account="123456789012")
    after = [r["message"] for r in doctorsvc.run_checks()["checks"]
             if r["check"] == "kubernetes-cloud-owned"]
    assert len(after) == 1 and "rc-support" in after[0], after
    assert "not the same as there being none" not in after[0]
