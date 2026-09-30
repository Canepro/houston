"""`houston.services.k8s.certmanager`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from houston import errors
import pytest


def test_cert_manager_is_adopted_or_installed_like_the_ingress(monkeypatch):
    """The guide lists cert-manager as a prerequisite AND gives the command, so
    houston runs the documented step rather than demanding it.

    Requiring it by hand while installing the ingress controller automatically was an
    inconsistency with no reason behind it -- both are things the guide tells an
    operator to install, and both are now adopt-or-install.

    Installed BY KUBECTL as the guide does it, and that is load-bearing rather than
    stylistic: the static manifest has no `startupapicheck` and no Job at all, so two
    of the seven findings recorded against this work cannot arise -- nothing can fail a
    post-install hook, and the `crds.enabled`-versus-`installCRDs` trap has nowhere to
    happen.
    """
    import subprocess as sp

    from houston.services import k8s

    # Already there: adopted, nothing run.
    ran: list[list[str]] = []
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: True)
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: ran.append(argv))
    k8s.ensure_cert_manager(context="c", distribution="k3s")
    assert ran == [], "nothing may be applied over a cert-manager already installed"

    # Absent on a local cluster: applied, then waited for.
    seen = {"n": 0}

    def present(ctx):
        seen["n"] += 1
        return seen["n"] > 1

    calls: list[list[str]] = []
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", present)
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: calls.append(argv)
                        or sp.CompletedProcess(argv, 0, "", ""))
    k8s.ensure_cert_manager(context="c", distribution="kind", sleep=lambda s: None)
    apply = next(c for c in calls if "apply" in c)
    assert apply[:2] == ["kubectl", "--context"], apply
    assert any(a.endswith("cert-manager.yaml") for a in apply), apply
    assert not any("helm" in a for a in apply), "the guide uses kubectl, not helm"
    # The WEBHOOK, not just the apply: an issuer created before it is serving is
    # accepted and then never reconciled.
    waited = [c for c in calls if "rollout" in c]
    assert len(waited) == len(k8s.CERT_MANAGER_DEPLOYMENTS), waited


def test_the_acme_issuer_is_the_official_guides_own_shape():
    """From docs.rocket.chat/docs/deploy-with-kubernetes, with two deliberate
    departures, both stated where the manifest is built:

    * `ingressClassName` rather than the guide's `class`, which is the deprecated
      spelling of the same field. Measured: an issuer written the guide's way reached
      `Ready=True reason=ACMEAccountRegistered` on cert-manager 1.21, so this is about
      not inheriting a deprecation.
    * http01 and NOT tls-alpn -- cert-manager does not implement tls-alpn at all,
      which is why the challenge differs from the Compose path's default.
    """
    import yaml as _yaml

    from houston.services import k8s

    doc = _yaml.safe_load(k8s.acme_issuer_manifest(
        k8s.IssuerSpec(mode="acme", acme_email="ops@example.com"),
        ingress_class="traefik"))
    acme = doc["spec"]["acme"]
    assert acme["server"] == k8s.ACME_PRODUCTION
    assert acme["email"] == "ops@example.com"
    assert acme["privateKeySecretRef"]["name"].endswith("-account-key")
    assert acme["solvers"] == [{"http01": {"ingress": {"ingressClassName": "traefik"}}}]
    assert "tlsALPN01" not in str(acme), "cert-manager does not implement it"


def test_a_contact_address_cannot_add_keys_to_a_cluster_scoped_issuer():
    """The ClusterIssuer was built by f-string, so an `acme_email` carrying newlines
    was interpolated verbatim and the result was VALID YAML cert-manager accepts.

    A ClusterIssuer is CLUSTER-SCOPED and shared by every workspace on the box, so
    `skipTLSVerify: true` injected through one workspace's contact address would
    apply to all of them. Pre-fix this rendered six keys under `spec.acme`; the two
    extra ones are the finding.
    """
    import yaml as _yaml

    from houston.services import k8s

    hostile = ("ops@example.com\n    skipTLSVerify: true\n"
               "    disableAccountKeyGeneration: true\n    # ")
    doc = _yaml.safe_load(k8s.acme_issuer_manifest(
        k8s.IssuerSpec(mode="acme", acme_email=hostile), ingress_class="traefik"))
    acme = doc["spec"]["acme"]
    assert set(acme) == {"server", "email", "privateKeySecretRef", "solvers"}, (
        "the contact address added keys to a cluster-scoped issuer")
    # It survives as ONE scalar rather than being dropped: the address is wrong and
    # Let's Encrypt will say so, which is the right place for that to fail.
    assert acme["email"] == hostile
    assert doc["kind"] == "ClusterIssuer" and doc["apiVersion"] == "cert-manager.io/v1"


def test_the_issuer_call_dispatches_on_the_spec_not_on_the_caller(monkeypatch):
    """One call site, two mechanisms. A branch at the caller is how `--https` and
    `--domain` would drift into two code paths again."""
    from houston.services import k8s

    seen: list[str] = []
    monkeypatch.setattr(k8s.certmanager, "ensure_ca_issuer",
                        lambda **kw: seen.append("ca"))
    monkeypatch.setattr(k8s.certmanager, "ensure_acme_issuer",
                        lambda spec, **kw: seen.append("acme"))
    k8s.ensure_issuer(k8s.IssuerSpec(mode="local"), context="c",
                      ingress_class="traefik")
    k8s.ensure_issuer(k8s.IssuerSpec(mode="acme", acme_email="a@b.c"), context="c",
                      ingress_class="traefik")
    assert seen == ["ca", "acme"]


def test_cert_manager_is_not_installed_into_somebody_elses_cluster(monkeypatch):
    """Six CRDs and an admission webhook change what a cluster IS, for every workload
    in it -- not something to do to a managed cluster on the way to booting a repro.
    There it names the command, and adopts as soon as it is there."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: pytest.fail("must not install"))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_cert_manager(context="prod", distribution="eks")
    msg = str(exc.value)
    assert "not on this machine" in msg
    assert "kubectl apply -f" in msg and "cert-manager.yaml" in msg, msg
    assert "adopts it as soon as it is there" in msg, "say what would change the answer"
    # Unknown locality must not read as local.
    monkeypatch.setattr(k8s.context, "distribution_of", lambda ctx: "")
    with pytest.raises(errors.PreflightError):
        k8s.ensure_cert_manager(context="prod", distribution="")


def test_cert_manager_applied_but_never_answering_is_a_failure(monkeypatch):
    """`kubectl apply` returns as soon as the objects are accepted. What matters is
    whether the cluster can issue a Certificate, which is the CRD being there."""
    import subprocess as sp

    from houston.services import k8s

    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, **kw: sp.CompletedProcess(argv, 0, "", ""))
    monkeypatch.setattr(k8s.tuning, "CERT_MANAGER_TRIES", 2)
    with pytest.raises(errors.CreateFailedError) as exc:
        k8s.ensure_cert_manager(context="c", distribution="kind", sleep=lambda s: None)
    assert "CRDs never appeared" in str(exc.value)


#: What the API server answered the ClusterIssuer apply on the live matrix's k3s playground,
#: straight after "installed and answering": the webhook pod Ready, its CA bundle not yet
#: injected. Shared with the TypeScript counterpart in src/core/kube/tier4.test.ts.
X509 = ('Error from server (InternalError): error when creating "STDIN": Internal error '
        'occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: '
        'Post "https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=30s": tls: '
        'failed to verify certificate: x509: certificate signed by unknown authority')


def test_installed_and_answering_waits_for_the_webhook_itself(monkeypatch):
    """"installed and answering" was said after the three rollouts and the CRD, and the
    very next create -- the ClusterIssuer -- failed with `failed calling webhook
    "webhook.cert-manager.io" ... x509: certificate signed by unknown authority`: the
    webhook pod was Ready and cainjector had not yet handed the API server its CA bundle.
    MEASURED by the live matrix on a k3s playground, in both builds (exit 7), whenever
    cert-manager's images were cached and the install was fast.

    The wait now dry-runs that ClusterIssuer server-side until the webhook accepts it and
    only then says so; a webhook that never does is a failure that names it and the command
    that shows its CA bundle. Pre-fix: no dry-run at all, "installed and answering" at once,
    and nothing raised.
    """
    import subprocess as sp

    from houston.services import k8s

    said: list[str] = []
    dry = {"n": 0, "failing": 2}
    asked = {"crd": 0}

    def present(ctx):
        asked["crd"] += 1
        return asked["crd"] > 1

    def run(argv, **kw):
        if "--dry-run=server" in argv:
            dry["n"] += 1
            said.append(f"dry-run {dry['n']}")
            manifest = kw.get("input") or ""
            assert "kind: ClusterIssuer" in manifest, manifest
            assert "tls.key" not in manifest, "a dry-run needs no private key"
            failing = dry["n"] <= dry["failing"]
            return sp.CompletedProcess(argv, 1 if failing else 0, "", X509 if failing else "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", present)
    monkeypatch.setattr(k8s.kube, "run", run)
    k8s.ensure_cert_manager(context="c", distribution="kind", sleep=lambda s: None,
                            emit=lambda ev: said.append(ev.message))
    assert said[1:] == ["dry-run 1", "dry-run 2", "dry-run 3",
                        "cert-manager: installed and answering"], said

    # One that never answers: refused, naming the webhook, and never called answering.
    said.clear()
    dry.update(n=0, failing=99)
    asked["crd"] = 0
    monkeypatch.setattr(k8s.tuning, "CERT_MANAGER_WEBHOOK_TRIES", 2)
    with pytest.raises(errors.CreateFailedError) as exc:
        k8s.ensure_cert_manager(context="c", distribution="kind", sleep=lambda s: None,
                                emit=lambda ev: said.append(ev.message))
    assert str(exc.value) == (
        "cert-manager's webhook in 'c' never accepted an object, so nothing can create an "
        f"issuer or a Certificate there: {X509}. `kubectl --context c -n cert-manager logs "
        "deploy/cert-manager-webhook`, and `kubectl --context c get "
        "validatingwebhookconfiguration cert-manager-webhook -o yaml` for its caBundle.")
    assert dry["n"] == 2
    assert "cert-manager: installed and answering" not in said


def test_the_webhook_wait_outlasts_the_leader_lease_a_removed_cert_manager_leaves(monkeypatch):
    """The third live run: `up --https` and `cluster prepare` exited 7 in BOTH builds, the
    webhook refusing every one of the wait's 20 dry-runs with the recorded x509 error.
    cert-manager's leader-election Leases are not in its manifest and outlive `kubectl
    delete -f` of it, and a new cainjector waits a full lease duration (60 s) after it first
    sees one before it injects the CA bundle. MEASURED on the playground: the webhook first
    accepted the dry-run at +89 s, where the wait, borrowing the CRD wait's 20 x 3 s, had
    given up at 60 s.

    The webhook now has its own bound, 180 s like the rollouts. Here it refuses 25 dry-runs
    and accepts the 26th, the measured count at 3 s apart. Pre-fix: CreateFailedError at the
    20th.
    """
    import subprocess as sp

    from houston.services import k8s

    said: list[str] = []
    slept: list[float] = []
    dry = {"n": 0}
    asked = {"crd": 0}

    def present(ctx):
        asked["crd"] += 1
        return asked["crd"] > 1

    def run(argv, **kw):
        if "--dry-run=server" in argv:
            dry["n"] += 1
            refused = dry["n"] <= 25
            return sp.CompletedProcess(argv, 1 if refused else 0, "", X509 if refused else "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", present)
    monkeypatch.setattr(k8s.kube, "run", run)
    k8s.ensure_cert_manager(context="c", distribution="kind", sleep=slept.append,
                            emit=lambda ev: said.append(ev.message))
    assert said[-1] == "cert-manager: installed and answering", said
    assert dry["n"] == 26
    assert slept == [k8s.CERT_MANAGER_INTERVAL] * 25, "3 s apart, the measured cadence"
    assert k8s.tuning.CERT_MANAGER_WEBHOOK_TRIES * k8s.CERT_MANAGER_INTERVAL == 180, \
        "the rollout waits' --timeout=180s"


def test_locality_was_standing_in_for_consent(monkeypatch):
    """Two guards refused to change a cluster that is not on this machine.

    The reasoning they carry is right and is not about locality: six CRDs and an
    admission webhook "are a change to what a cluster IS, for every workload in it --
    not something to do to somebody else's ON THE WAY TO BOOTING A REPRO". What makes
    that wrong is that nobody asked. `cluster prepare` is somebody asking, and for a
    cluster houston provisioned there is no somebody else to be careful of.

    `up` must never pass it, or the implicit install these guards exist to stop comes
    straight back.
    """
    import inspect

    from houston.services import k8s
    from houston.services import lifecycle as lcmod

    for fn in (k8s.ensure_ingress, k8s.ensure_cert_manager):
        assert "invited" in inspect.signature(fn).parameters, fn.__name__
        assert inspect.signature(fn).parameters["invited"].default is False, \
            f"{fn.__name__} must refuse by default; consent is the exception"

    # Uninvited on a remote cluster: refused, exactly as before.
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s.context, "distribution_of", lambda ctx: "eks")
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_cert_manager(context="arn:aws:eks:x", distribution="eks")
    assert "not on this machine" in str(exc.value)

    # `up` never invites -- checked in the source, because a future edit that adds it
    # would restore the exact defect these guards were written for.
    assert "invited=" not in source_of(lcmod), \
        "the implicit create path must never invite an install into somebody's cluster"
