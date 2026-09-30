"""cert-manager and the issuers a workspace's ingress names.

Installed only into a cluster houston may write to, and only after every read-only
refusal has passed -- an install left behind by a refusal is the defect this ordering
was measured against.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.services.events import Emit
from houston.errors import PreflightError
from dataclasses import dataclass
from houston.services.events import info
from houston.services.events import null_emit
import time
from houston.services.events import warn

from houston.services.k8s import ask
from houston.services.k8s import context as kubectx
from houston.services.k8s import names as vocab
from houston.services.k8s import release as kuberelease
from houston.services.k8s.exec import kube
from houston.services.k8s.monitoring import CERT_MANAGER_NAMESPACE
from houston.services.k8s.names import INSTALL_TIMEOUT, OWNER_LABEL_KEY, OWNER_LABEL_VALUE, tuning

def cert_manager_installed(context: str) -> bool:
    """Whether cert-manager can issue in this cluster.

    Keyed on the CRD rather than on a Deployment name or a helm release: the release
    can be named anything, and `installCRDs` versus `crds.enabled` differ by
    cert-manager version -- but nothing can issue a Certificate without the CRD, and
    its absence is exactly the failure that reads as "no matches for kind
    ClusterIssuer".
    """
    res = kube.run(["kubectl", "--context", context, "get", "crd",
               "certificates.cert-manager.io", "-o", "name"], own=vocab.is_ours(context))
    return res.returncode == 0 and "certificates.cert-manager.io" in (res.stdout or "")

#: The pinned cert-manager release, and the command a person runs to get it. The
#: OFFICIAL Rocket.Chat guide installs cert-manager with kubectl, not helm, and lists
#: it as a PREREQUISITE alongside a StorageClass and an ingress controller -- so
#: houston requires it and names this, rather than installing it into a cluster it
#: does not own.
#:
#: Following the guide here is not deference, it deletes work. Two of the seven
#: findings in `.docs/design/k8s-https.md` §4 are artefacts of the HELM chart and do
#: not exist on this path: verified against the real v1.21.1 manifest, it contains no
#: `startupapicheck` and no Job of any kind, so nothing can fail a post-install hook,
#: and it carries the six CRDs directly, so the `crds.enabled`-versus-`installCRDs`
#: trap has nowhere to happen.
CERT_MANAGER_VERSION = "v1.21.1"

CERT_MANAGER_MANIFEST = ("https://github.com/cert-manager/cert-manager/releases/"
                         f"download/{CERT_MANAGER_VERSION}/cert-manager.yaml")

#: houston's own issuer, and the Secret holding the CA that backs it. A
#: ClusterIssuer reads its Secret from the cluster-resource namespace, which for a
#: default cert-manager install is its own.
CA_ISSUER = "houston-ca"

CA_ISSUER_SECRET = "houston-ca"

ISSUER_WAIT_INTERVAL = 2.0

#: How long to wait for cert-manager to issue. 45 x 2s = 90 seconds was too tight for
#: a FIRST issuance on a cold cluster: the ACME account has to be registered, the order
#: placed, the http-01 challenge served and validated by Let's Encrypt from outside,
#: and on a first workspace all of that starts only once the image pull has finished.
#:
#: OBSERVED through the GUI on a fresh EKS cluster -- the wait expired, the ingress
#: answered with its own default certificate, and the certificate arrived about a
#: minute later. The cost of waiting longer is bounded and only paid with `--domain`;
#: the cost of giving up early is a create that ends by reporting a failure that is
#: not one.
CERT_WAIT_TRIES = 90

CERT_WAIT_INTERVAL = 2.0

#: The ACME directories, and two ISSUER NAMES rather than one with a flag. Switching
#: staging on and off must not reuse an account registered against the other
#: directory: `privateKeySecretRef` holds the ACME account key, and pointing a
#: production order at a staging account fails in a way that names neither. `tls.py`
#: separates its storage file for the same reason.
ACME_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory"

ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"

ACME_ISSUER = "houston-acme"

ACME_ISSUER_STAGING = "houston-acme-staging"

@dataclass(frozen=True)
class IssuerSpec:
    """Which ClusterIssuer a workspace's Ingress should name, and how to make it.

    Two issuers, ONE mechanism, and that is the whole point of following the official
    guide's values.yaml: `ingress.enabled`, `ingressClassName`, the
    `cert-manager.io/cluster-issuer` annotation and `ingress.tls` are byte-identical
    between them. The difference between a local certificate and a publicly trusted
    one is the issuer NAME -- one field -- which is as close as a support box can get
    to reproducing the file a customer actually wrote.
    """
    mode: str                      # tls.MODE_LOCAL | tls.MODE_ACME
    acme_email: str = ""
    acme_staging: bool = False

    @property
    def name(self) -> str:
        if self.mode != "acme":
            return CA_ISSUER
        return ACME_ISSUER_STAGING if self.acme_staging else ACME_ISSUER

    @property
    def directory(self) -> str:
        return ACME_STAGING if self.acme_staging else ACME_PRODUCTION

#: The three Deployments the official manifest creates. Waited for by name, because
#: the manifest has no hooks and `kubectl apply` returns the moment the objects are
#: accepted -- and a ClusterIssuer created before the webhook is serving is accepted
#: and then never reconciled, which is `k8s-https.md` §4's third finding.
CERT_MANAGER_DEPLOYMENTS = ("cert-manager", "cert-manager-webhook",
                            "cert-manager-cainjector")

CERT_MANAGER_INTERVAL = 3.0


def _wait_for_cert_manager(context: str, emit: Emit, sleep) -> None:
    """Wait for cert-manager's deployments and CRDs after applying its manifest."""
    # THE WEBHOOK, not just the apply. `kubectl apply` returns as soon as the objects
    # are accepted, and a ClusterIssuer created before the webhook is serving is
    # accepted and then never reconciled -- no `.status` at all, so no Certificate ever
    # issues and nothing says why.
    for name in CERT_MANAGER_DEPLOYMENTS:
        kube.run(["kubectl", "--context", context, "-n", CERT_MANAGER_NAMESPACE,
             "rollout", "status", f"deployment/{name}", "--timeout=180s"],
            timeout=INSTALL_TIMEOUT, own=vocab.is_ours(context))
    # And the CRD, which is what "can this cluster issue a Certificate" actually means.
    for attempt in range(tuning.CERT_MANAGER_TRIES):
        if cert_manager_installed(context):
            break
        if attempt < tuning.CERT_MANAGER_TRIES - 1:
            sleep(CERT_MANAGER_INTERVAL)
    else:
        raise CreateFailedError(
            f"cert-manager was applied to {context!r} but its CRDs never appeared, so "
            f"nothing can issue a Certificate there. `kubectl -n "
            f"{CERT_MANAGER_NAMESPACE} get pods` and `kubectl get crd | grep cert-manager`.")
    _wait_for_the_webhook(context, sleep)
    info(emit, "cert-manager: installed and answering", phase="tls")


def _wait_for_the_webhook(context: str, sleep) -> None:
    """ANSWERING, which a Ready webhook pod is not yet: prove it with the object that is next.

    The webhook pod rolls out Ready as soon as it serves, but the API server calls it with
    the CA bundle cainjector copies into its webhook configurations, and on a fresh
    install that copy lands some seconds LATER. Until it does, every create of a
    cert-manager object fails with `failed calling webhook "webhook.cert-manager.io" ...
    x509: certificate signed by unknown authority`. MEASURED on a k3s playground by the
    live matrix: the apply straight after "installed and answering" failed that way (exit
    7) in TypeScript's run of the first, which met cert-manager's images already cached,
    and in BOTH builds on the second; an install that pulled its images had simply been
    slow enough to miss the window.

    So the wait asks the webhook itself: a server-side dry-run of the ClusterIssuer that
    `ensure_ca_issuer` creates next goes through the same admission call and persists
    nothing.

    Bounded, but by its OWN bound, `tuning.CERT_MANAGER_WEBHOOK_TRIES` (60 x 3 s = 180 s,
    the rollout waits' `--timeout=180s`), not the CRD wait's 60 s. cainjector injects the
    bundle only once it holds its leader lease, and cert-manager's two Leases,
    `kube-system/cert-manager-cainjector-leader-election` and
    `kube-system/cert-manager-controller`, are created at run time, are not in the
    manifest, and OUTLIVE `kubectl delete -f` of it.
    A new candidate that finds a lease it does not hold waits a full lease duration (60 s)
    from when it first sees it, plus its retry period, however long ago the old holder
    died. MEASURED on the live matrix's k3s playground after a fresh apply of the pinned
    v1.21.1 manifest on a cluster that had had cert-manager: the three Deployments rolled
    out at +12 s, cainjector logged "Attempting to acquire leader lease" at 05:51:48 and
    "Successfully acquired lease" at 05:53:07, and the webhook first accepted this dry-run
    at +89 s. At 60 s both builds refused every such cluster (the third run, exit 7); the
    first run's first install passed only because its cluster had never had cert-manager.
    """
    res = None
    for attempt in range(tuning.CERT_MANAGER_WEBHOOK_TRIES):
        res = kube.run(["kubectl", "--context", context, "apply", "--dry-run=server", "-f", "-"],
                       input=_ca_cluster_issuer_manifest(), own=vocab.is_ours(context))
        if res.returncode == 0:
            return
        if attempt < tuning.CERT_MANAGER_WEBHOOK_TRIES - 1:
            sleep(CERT_MANAGER_INTERVAL)
    raise CreateFailedError(
        f"cert-manager's webhook in {context!r} never accepted an object, so nothing can "
        f"create an issuer or a Certificate there: " + ask.why(res)
        + f". `kubectl --context {context} -n {CERT_MANAGER_NAMESPACE} logs "
          f"deploy/cert-manager-webhook`, and `kubectl --context {context} get "
          f"validatingwebhookconfiguration cert-manager-webhook -o yaml` for its caBundle.")


def ensure_cert_manager(*, context: str, distribution: str = "",
                        invited: bool = False,
                        emit: Emit = null_emit, sleep=time.sleep) -> None:
    """Adopt cert-manager if the cluster has it, install it if not.

    THE GUIDE LISTS IT AS A PREREQUISITE AND GIVES THE COMMAND, which is the argument
    for doing it rather than asking: `kubectl apply -f` the pinned release manifest is
    a documented step, and requiring it by hand while installing the ingress
    controller automatically was an inconsistency with no reason behind it.

    Installed exactly as the guide installs it -- by kubectl, not helm -- and that
    choice is load-bearing rather than stylistic. The static manifest contains no
    `startupapicheck` and no Job at all, so two of the seven findings recorded against
    this work simply do not arise: nothing can fail a post-install hook, and the
    `crds.enabled`-versus-`installCRDs` trap has nowhere to happen. Verified against
    the real artefact: 6 CRDs, 3 Deployments, 1 Namespace, `grep -c Job` = 0.

    **Only on a cluster that is on this machine, unless invited.** Six CRDs and an
    admission webhook are a change to what a cluster IS, for every workload in it --
    not something to do to somebody else's ON THE WAY TO BOOTING A REPRO. That last
    clause is the whole of the rule, and locality was standing in for it: what makes
    an implicit install wrong is that nobody asked, not where the cluster is.

    `invited=True` is `cluster prepare` saying somebody did ask -- it is a verb a
    human runs at a cluster on purpose, and for one houston provisioned there is no
    "somebody else" to be careful of. `up` never passes it, so the implicit path this
    guard was written for is unchanged.

    **Never removed.** `kubectl delete -f` takes the CRDs, and removing the CRDs
    garbage-collects every Certificate and Issuer in the cluster -- the user's
    included. There is no reference count that makes that safe, so there is no removal.
    """
    if cert_manager_installed(context):
        info(emit, "cert-manager: already in this cluster", phase="tls")
        return
    if not invited and not kubectx.is_local_cluster(distribution
                                            or kubectx.distribution_of(context)):
        raise PreflightError(
            f"cluster {context!r} has no cert-manager, and it is not on this machine, "
            f"so houston will not install one: six CRDs and an admission webhook "
            f"change what that cluster is, for every workload in it. The official "
            f"Rocket.Chat guide installs it as a prerequisite:\n"
            f"    {cert_manager_install_hint()}\n"
            f"  houston adopts it as soon as it is there.")
    info(emit, f"no cert-manager in {context!r} — installing "
               f"{CERT_MANAGER_VERSION} (once per cluster, the guide's own command)",
         phase="tls", pct=10)
    res = kube.run(["kubectl", "--context", context, "apply", "-f", CERT_MANAGER_MANIFEST],
              timeout=INSTALL_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        raise CreateFailedError(
            f"could not install cert-manager into {context!r}: " + ask.why(res)
            + f" — it is one command if you would rather run it yourself: "
              f"{cert_manager_install_hint()}")
    _wait_for_cert_manager(context, emit, sleep)

def cert_manager_install_hint() -> str:
    """What to run to satisfy the prerequisite, quoted from the official guide."""
    return f"kubectl apply -f {CERT_MANAGER_MANIFEST}"

def ca_issuer_manifest(cert_pem: str, key_pem: str) -> str:
    """The CA Secret and the ClusterIssuer that signs from it.

    `stringData`, so Kubernetes does the base64 -- same reasoning as
    `mongo_secret_manifest`, and the PEM never has to be re-encoded correctly here.

    A `ca` issuer rather than an `acme` one is what makes `--https` and `--domain` the
    same values.yaml with one field different. The official guide's ingress block is
    unchanged: `ingress.enabled`, `ingressClassName`, the
    `cert-manager.io/cluster-issuer` annotation and `ingress.tls` are identical, and
    only the issuer this names differs. So a customer's file and houston's file
    differ in the issuer NAME, which is the closest a local box can get to the thing
    being reproduced.
    """
    def indent(pem: str) -> str:
        return "\n".join(f"    {ln}" for ln in pem.strip().splitlines())
    return (
        f"---\napiVersion: v1\nkind: Secret\nmetadata:\n"
        f"  name: {CA_ISSUER_SECRET}\n  namespace: {CERT_MANAGER_NAMESPACE}\n"
        f"  labels:\n    {OWNER_LABEL_KEY}: {OWNER_LABEL_VALUE}\n"
        f"type: kubernetes.io/tls\nstringData:\n"
        f"  tls.crt: |\n{indent(cert_pem)}\n"
        f"  tls.key: |\n{indent(key_pem)}\n"
        + _ca_cluster_issuer_manifest())

def _ca_cluster_issuer_manifest() -> str:
    """The ClusterIssuer half of `ca_issuer_manifest`, on its own: it carries no key, so
    `_wait_for_the_webhook` can dry-run it before anything is created."""
    return (
        f"---\napiVersion: cert-manager.io/v1\nkind: ClusterIssuer\nmetadata:\n"
        f"  name: {CA_ISSUER}\n"
        f"  labels:\n    {OWNER_LABEL_KEY}: {OWNER_LABEL_VALUE}\n"
        f"spec:\n  ca:\n    secretName: {CA_ISSUER_SECRET}\n")

def ensure_ca_issuer(*, context: str, emit: Emit = null_emit,
                     sleep=time.sleep) -> None:
    """Put houston's CA in the cluster as a `ca` ClusterIssuer, and wait for it.

    THE WAIT IS THE POINT, and it is `k8s-https.md` §4's third finding: a ClusterIssuer
    created before cert-manager is ready is ACCEPTED and then never reconciled -- no
    `.status` at all, so no Certificate ever issues and nothing says why. Waiting for
    `Ready=True` here means a workspace either has a working issuer or a refusal, and
    never the silent third thing.

    Measured on a live k3s: `Ready=True reason=KeyPairVerified msg="Signing CA
    verified"`, and a Certificate issued from it in about three seconds.
    """
    from houston import tls_local

    key_path, crt_path = tls_local.ensure_ca()
    info(emit, f"issuer {CA_ISSUER} from houston's own CA (once per cluster)",
         phase="tls")
    kuberelease.apply(ca_issuer_manifest(crt_path.read_text(encoding="utf-8"),
                             key_path.read_text(encoding="utf-8")),
          namespace=CERT_MANAGER_NAMESPACE, context=context)
    for attempt in range(tuning.ISSUER_WAIT_TRIES):
        seen = ask.ask_object("clusterissuer", CA_ISSUER, context=context)
        if seen.present:
            for cond in (((seen.doc or {}).get("status") or {}).get("conditions") or []):
                if cond.get("type") == "Ready" and str(cond.get("status")) == "True":
                    info(emit, f"issuer {CA_ISSUER} ready — "
                               f"{cond.get('message') or 'signing CA verified'}",
                         phase="tls")
                    return
        if attempt < tuning.ISSUER_WAIT_TRIES - 1:
            sleep(ISSUER_WAIT_INTERVAL)
    raise PreflightError(
        f"the ClusterIssuer {CA_ISSUER} did not become ready in cluster {context!r}. "
        f"cert-manager accepts an issuer it is not yet able to reconcile and then "
        f"says nothing, so a workspace built on it would never get a certificate. "
        f"`kubectl describe clusterissuer {CA_ISSUER}`, then try again.")

def acme_issuer_manifest(spec: IssuerSpec, *, ingress_class: str) -> str:
    """The official guide's own ClusterIssuer, with houston's name on it.

    From docs.rocket.chat/docs/deploy-with-kubernetes, unchanged in shape:

        spec:
          acme:
            server: https://acme-v02.api.letsencrypt.org/directory
            email: user01@mycompany.com
            privateKeySecretRef:
              name: cert-manager-secret-production
            solvers:
            - http01:
                ingress:
                  class: traefik

    `ingressClassName` rather than the guide's `class`, which is the deprecated
    spelling of the same field -- cert-manager 1.21 accepts both (measured: an issuer
    written the guide's way reached `Ready=True reason=ACMEAccountRegistered`), and
    naming the current field is what stops this being a deprecation warning later.

    **http01, and NOT tls-alpn, because cert-manager does not implement tls-alpn at
    all.** That is worth stating where the choice is made: the Compose path defaults
    to TLS-ALPN and this one cannot, so "the challenge houston uses" is not one
    answer across runtimes. dns-01 is the other thing cert-manager supports and is
    per-provider work that is not built.
    """
    # BUILT AS A DOCUMENT, NOT A STRING. This was an f-string, and `acme_email` is
    # caller-supplied -- so an address carrying newlines added its own keys to
    # `spec.acme` and the result was valid YAML cert-manager accepts. A
    # ClusterIssuer is CLUSTER-SCOPED and shared by every workspace on the box, so
    # `skipTLSVerify: true` injected here would apply to all of them, which is why
    # this one is dumped rather than escaped: safe_dump quotes whatever it is given
    # and there is no grammar left for a value to escape.
    import yaml as _yaml
    doc = {
        "apiVersion": "cert-manager.io/v1",
        "kind": "ClusterIssuer",
        "metadata": {"name": spec.name,
                     "labels": {OWNER_LABEL_KEY: OWNER_LABEL_VALUE}},
        "spec": {"acme": {
            "server": spec.directory,
            "email": spec.acme_email,
            "privateKeySecretRef": {"name": f"{spec.name}-account-key"},
            "solvers": [{"http01": {"ingress": {"ingressClassName": ingress_class}}}],
        }},
    }
    # `---` and key order preserved: the document is written into the workspace
    # directory for a human to read, and reordering it would make every diff noise.
    return "---\n" + _yaml.safe_dump(doc, sort_keys=False)

def ensure_acme_issuer(spec: IssuerSpec, *, context: str, ingress_class: str,
                       emit: Emit = null_emit, sleep=time.sleep) -> None:
    """Register an ACME account in the cluster and wait for it. Idempotent.

    The wait is the same one `ensure_ca_issuer` makes and for the same reason, but the
    failure it catches is different and more common: this issuer makes a real network
    call to Let's Encrypt to register an account, so a cluster with no egress, a wrong
    email or a rate-limited account fails HERE -- once, with a reason -- rather than
    silently per Certificate afterwards.
    """
    which = "staging" if spec.acme_staging else "production"
    info(emit, f"issuer {spec.name} — Let's Encrypt {which}, http-01 via "
               f"{ingress_class} (once per cluster)", phase="tls")
    kuberelease.apply(acme_issuer_manifest(spec, ingress_class=ingress_class),
          namespace=CERT_MANAGER_NAMESPACE, context=context)
    for attempt in range(tuning.ISSUER_WAIT_TRIES):
        seen = ask.ask_object("clusterissuer", spec.name, context=context)
        if seen.present:
            for cond in (((seen.doc or {}).get("status") or {}).get("conditions") or []):
                if cond.get("type") == "Ready" and str(cond.get("status")) == "True":
                    info(emit, f"issuer {spec.name} ready — "
                               f"{cond.get('message') or 'ACME account registered'}",
                         phase="tls")
                    return
        if attempt < tuning.ISSUER_WAIT_TRIES - 1:
            sleep(ISSUER_WAIT_INTERVAL)
    raise PreflightError(
        f"the ClusterIssuer {spec.name} did not become ready in cluster {context!r}. "
        f"Registering an ACME account is a real call to {spec.directory} from inside "
        f"the cluster, so this is usually no egress from the pods, or a rejected "
        f"contact address. `kubectl describe clusterissuer {spec.name}` says which.")

def ensure_issuer(spec: IssuerSpec, *, context: str, ingress_class: str,
                  emit: Emit = null_emit) -> None:
    """Make the issuer this workspace's Ingress is about to name.

    One call site, two mechanisms, chosen by the spec rather than by a branch at the
    caller -- which is what keeps `--https` and `--domain` the same code path with a
    different issuer, as the guide's values.yaml already implies.
    """
    if spec.mode == "acme":
        ensure_acme_issuer(spec, context=context, ingress_class=ingress_class,
                           emit=emit)
    else:
        ensure_ca_issuer(context=context, emit=emit)

def wait_for_certificate(name: str, *, namespace: str, context: str,
                         emit: Emit = null_emit, sleep=time.sleep) -> bool:
    """Wait for cert-manager to issue `name`. Returns whether it did.

    NOT fatal, and deliberately: the workspace itself is up and reachable on its
    port-forward whatever the certificate does, so a certificate that has not arrived
    is a thing to SAY rather than a reason to destroy a workspace somebody waited
    minutes for. Same call the Compose path makes about an ACME name.
    """
    for attempt in range(CERT_WAIT_TRIES):
        seen = ask.ask_object("certificate", name, namespace=namespace, context=context)
        if seen.present:
            for cond in (((seen.doc or {}).get("status") or {}).get("conditions") or []):
                if cond.get("type") == "Ready" and str(cond.get("status")) == "True":
                    return True
        if attempt < CERT_WAIT_TRIES - 1:
            sleep(CERT_WAIT_INTERVAL)
    warn(emit, f"the certificate {name} in {namespace} is not Ready yet — the "
               f"workspace is up either way. `kubectl -n {namespace} describe "
               f"certificate {name}` says what cert-manager is waiting for.",
         phase="tls")
    return False

def tls_secret_for(name: str) -> str:
    """The Secret cert-manager fills for a workspace's Ingress."""
    return f"{name}-tls"
