"""`houston.services.k8s.ask`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _completed
import pytest
import subprocess


def test_a_failure_reports_its_reason_not_the_warnings_printed_before_it():
    """A real `helm install` failure surfaced two harmless duplicate-port warnings
    and hid its own reason, because the message took the FIRST 400 characters of
    stderr.

    Every tool here prints diagnostics first and its error last -- helm emits klog
    warnings then `Error: ...`, kubectl emits deprecation notices then the message --
    so a prefix reliably shows the least useful part. Warnings are not errors,
    however loudly they are printed.
    """
    import subprocess as sp

    from houston.services import k8s

    noisy = sp.CompletedProcess([], 1, "", (
        'I0813 18:03:17.247875 477232 warnings.go:107] "Warning: '
        'spec.template.spec.containers[2].ports[0]: duplicate port definition"\n'
        'I0813 18:03:17.247897 477232 warnings.go:107] "Warning: duplicate port '
        'name \\"metrics\\""\n'
        "Error: INSTALLATION FAILED: cannot re-use a name that is still in use"))
    got = k8s.why(noisy)
    assert "cannot re-use a name" in got, got
    assert "warnings.go" not in got, "a warning was reported as the failure"

    # No self-announcing error line: the last line is where these tools put it.
    assert k8s.why(sp.CompletedProcess([], 1, "", "connection refused")) == \
        "connection refused"
    # Nothing at all still says something, rather than an empty message.
    assert k8s.why(sp.CompletedProcess([], 1, "", "")) == "no reason given"
    # stdout is consulted too -- kubectl puts some failures there.
    assert "boom" in k8s.why(sp.CompletedProcess([], 1, "boom", ""))


def test_a_load_balancer_with_both_an_ip_and_a_hostname_yields_one_of_them(monkeypatch):
    """The jsonpath this replaces interpolated ip and hostname adjacently.

    It was safe only because the two platforms in play populate exactly one each --
    k3s ServiceLB sets `ip`, an AWS ELB/NLB sets `hostname`. A Service carrying both,
    which some controllers and every dual-stack setup produce, yielded the two
    concatenated into one nonsense string that travelled into `IngressEndpoint.address`
    and out as a printed CNAME target somebody would paste into DNS.

    Hostname wins where both exist: a CNAME target has to be a name, and an ELB's
    addresses change under it.
    """
    from houston.services import k8s

    def svc(name, **ingress):
        return {"metadata": {"name": name}, "spec": {"type": "LoadBalancer"},
                "status": {"loadBalancer": {"ingress": [ingress]}}}

    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [svc("both", ip="10.0.0.9", hostname="a.elb.aws")]}))
    assert k8s.loadbalancer_service("c") == ("both", "a.elb.aws")

    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [svc("k3s-ish", ip="172.16.0.2")]}))
    assert k8s.loadbalancer_service("c") == ("k3s-ish", "172.16.0.2")

    # An address-less entry first must not read as "a load balancer with no address" --
    # the old code looked at `ingress[0]` and nothing else.
    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(k8s.PRESENT, {
        "items": [{"metadata": {"name": "late"}, "spec": {"type": "LoadBalancer"},
                   "status": {"loadBalancer": {"ingress": [{}, {"hostname": "b.aws"}]}}}]}))
    assert k8s.loadbalancer_service("c") == ("late", "b.aws")

    # A ClusterIP Service is not a load balancer, whatever its status says.
    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(k8s.PRESENT, {
        "items": [{"metadata": {"name": "cip"}, "spec": {"type": "ClusterIP"},
                   "status": {"loadBalancer": {"ingress": [{"ip": "1.2.3.4"}]}}}]}))
    assert k8s.loadbalancer_service("c") == ("", "")


def test_the_ingress_class_adopted_is_the_clusters_own_default_not_the_first_listed(
        monkeypatch):
    """An EKS cluster carrying both `alb` and `nginx` had the choice made by whichever
    the API server happened to list first.

    The two behave differently for ACME http-01 solving and for `ingress_endpoint`
    discovery, so that is a real difference decided by nothing. Kubernetes already has
    an answer -- `ingressclass.kubernetes.io/is-default-class` is how a cluster says
    which controller an unclassed Ingress gets -- so somebody has stated a preference
    and houston should not overrule it.
    """
    from houston.services import k8s

    def klass(name, default=False):
        meta = {"name": name}
        if default:
            meta["annotations"] = {
                "ingressclass.kubernetes.io/is-default-class": "true"}
        return {"metadata": meta}

    # The API lists alb first; nginx is the cluster's declared default.
    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [klass("alb"), klass("nginx", default=True)]}))
    assert k8s.ingress_classes("c")[0] == "nginx", \
        "the cluster said which one it prefers and was overruled by list order"

    # With no default, the order is by name -- arbitrary, but the SAME arbitrary
    # answer every time, which "whatever the API listed first" was not.
    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [klass("zeta"), klass("alpha")]}))
    assert k8s.ingress_classes("c") == ["alpha", "zeta"]

    # A refused read stays None -- "I could not ask" is not "there are none".
    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.REFUSED, None, subprocess.CompletedProcess([], 1, "", "denied")))
    assert k8s.ingress_classes("c") is None


def test_an_acme_issuer_that_never_registers_says_why(monkeypatch):
    """Registering an ACME account is a real call to Let's Encrypt FROM INSIDE the
    cluster, so this fails on no pod egress or a rejected contact address -- and it
    should fail once, here, rather than silently per Certificate afterwards."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.release, "apply", lambda *a, **kw: None)
    monkeypatch.setattr(k8s.ask, "ask_object",
                        lambda *a, **kw: k8s.Answer(k8s.PRESENT, {"metadata": {}}))
    monkeypatch.setattr(k8s.tuning, "ISSUER_WAIT_TRIES", 2)
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_acme_issuer(k8s.IssuerSpec(mode="acme", acme_email="a@b.c"),
                               context="c", ingress_class="traefik",
                               sleep=lambda s: None)
    msg = str(exc.value)
    assert "egress" in msg and "contact address" in msg, msg


def test_an_issuer_that_never_reconciles_is_a_refusal_not_a_silence(monkeypatch):
    """`k8s-https.md` §4's third finding: a ClusterIssuer created before cert-manager
    is ready is ACCEPTED and then never reconciled -- no `.status` at all -- so no
    Certificate ever issues and nothing says why.

    Waiting for `Ready=True` means a workspace has either a working issuer or a
    refusal, never the silent third thing.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.release, "apply", lambda *a, **kw: None)
    monkeypatch.setattr(k8s.ask, "ask_object",
                        lambda *a, **kw: k8s.Answer(k8s.PRESENT, {"metadata": {}}))
    monkeypatch.setattr(k8s.tuning, "ISSUER_WAIT_TRIES", 2)
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_ca_issuer(context="c", sleep=lambda s: None)
    assert "did not become ready" in str(exc.value)
    assert "says nothing" in str(exc.value), "name the failure mode, not just the wait"

    # And it returns quietly once the condition is there.
    monkeypatch.setattr(k8s.ask, "ask_object", lambda *a, **kw: k8s.Answer(
        k8s.PRESENT, {"status": {"conditions": [
            {"type": "Ready", "status": "True", "message": "Signing CA verified"}]}}))
    k8s.ensure_ca_issuer(context="c", sleep=lambda s: None)


def test_a_multi_line_helm_error_keeps_its_reason(monkeypatch):
    """`why()` took the last line announcing itself as an error, and a Helm TEMPLATE
    error puts the location on that line and the cause on the indented lines after it.

    So the file and line survived and `nil pointer` did not -- which is what made the
    chart-version upgrade failure unreadable from houston's own output. The
    docstring's premise, diagnostics first and error last, holds for klog and inverts
    here.
    """
    from houston.services import k8s

    helm = ("Error: UPGRADE FAILED: template: rocketchat/templates/podmonitor.yaml:24:18\n"
            '  executing "podmonitor.yaml" at <.Values.podMonitor.enabled>:\n'
            "    nil pointer evaluating interface {}.enabled\n")
    got = k8s.why(_completed(1, err=helm))
    assert "nil pointer" in got, got
    assert "podmonitor.yaml:24:18" in got, "the location is still useful"

    # The klog case must be untouched: a warning is not an error however loudly printed.
    klog = ("W0824 12:00:00.1 warnings.go:70] v1 Endpoints is deprecated\n"
            "Error: release: not found\n")
    assert k8s.why(_completed(1, err=klog)) == "Error: release: not found"


def test_a_cluster_aws_says_is_gone_is_reported_gone_but_an_unreachable_one_is_not(
        monkeypatch, tmp_path):
    """`cluster delete` removes the cluster, not every kubeconfig entry naming it.

    Two tools wrote those entries, so a cluster deleted some OTHER way -- from the
    console, by a colleague -- keeps a context for ever, and its card says only "not
    answering": the alarming way to say nothing is there.

    ONLY ON A DEFINITE NO. `describe_cluster` answers PRESENT, ABSENT or REFUSED, and
    only ABSENT is AWS asserting it is not there. REFUSED means "I could not ask" --
    expired credentials, no route, a permission boundary -- and calling that gone would
    report a BILLING cluster as deleted, which is the one mistake this module exists to
    prevent.

    In `status` and NOT in `known_contexts`: this costs an AWS round trip, and the list
    is the function whose whole contract is that it probes nothing -- one probe per
    cloud cluster on a four-second poll is what made the page slow enough to be
    reported. Its own test holds that line; this one holds the behaviour.
    """
    from houston import config
    from houston.services import cluster as clustersvc
    from houston.services import eks as ekssvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    cfg = config.load_config(); cfg[config.KUBE_CONTEXT_KEY] = ARN; config.save_config(cfg)
    monkeypatch.setattr(k8s.context, "assert_context_known", lambda c: (c, ""))
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/" + t)
    # It does not answer -- which on its own says nothing about whether it exists.
    monkeypatch.setattr(k8s.reachability, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_DOWN))

    monkeypatch.setattr(ekssvc.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.ABSENT))
    said = clustersvc.status(ARN)
    assert said["gone"] is True, "AWS said it is not there; the card must say so"
    assert "no longer exists" in said["reach_advice"]
    assert "forget" in said["reach_advice"], \
        "an operator told a cluster is gone needs the command that clears the entry"

    monkeypatch.setattr(ekssvc.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))
    assert clustersvc.status(ARN)["gone"] is False, \
        "'I could not ask' is not 'it is gone', and a cluster wrongly called deleted " \
        "is a bill nobody goes looking for"

    # A context that is not an EKS ARN is never asked about at all -- there is no AWS
    # question to ask about a kind or k3s cluster, and asking would spend a timeout.
    monkeypatch.setattr(ekssvc.aws, "describe_cluster",
                        lambda n, r: pytest.fail("asked AWS about a local cluster"))
    assert clustersvc.status("default")["gone"] is False


def test_the_operator_scope_reader_tells_own_namespace_from_unreadable(monkeypatch):
    """`WATCH_NAMESPACE` unset via a fieldRef is the chart's single-namespace default.

    That is a real answer -- own namespace only -- and reporting it as unreadable would
    make houston adopt an operator it has just been told does not cover it.
    """
    from houston.services import k8s

    dep = {"metadata": {"namespace": "platform"},
           "spec": {"template": {"spec": {"containers": [
               {"env": [{"name": "WATCH_NAMESPACE",
                         "valueFrom": {"fieldRef": {}}}]}]}}}}
    monkeypatch.setattr(k8s.ask, "ask_list",
                        lambda *a, **k: k8s.Answer(k8s.PRESENT, {"items": [dep]}))
    assert k8s.operator_watch_scope("c") == ("platform", "")

    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.REFUSED, None, subprocess.CompletedProcess([], 1, "", "denied")))
    scope, unreadable = k8s.operator_watch_scope("c")
    assert scope == "" and unreadable, "a refusal is not an empty scope"

    assert k8s.operator_watches("*", "houston-t1")
    assert k8s.operator_watches("a,houston-t1", "houston-t1")
    assert not k8s.operator_watches("a,b", "houston-t1")


def test_a_refused_service_read_is_not_a_cluster_without_load_balancers(monkeypatch):
    """`loadbalancer_state` counts pending Services, and a refused read counts none.

    The caller must not then wait three minutes on a cluster it could not read; it
    returns immediately, and the empty address is reported as the honest "no address"
    it already was rather than becoming a new claim.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.ask, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.REFUSED, None, subprocess.CompletedProcess([], 1, "", "denied")))
    assert k8s.loadbalancer_state("c") == ("", "", 0)
    slept: list = []
    assert k8s.wait_for_loadbalancer("c", sleep=slept.append) == ("", "")
    assert slept == []
