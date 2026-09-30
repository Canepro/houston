"""The ingress controller, adopted when one is already there and installed when not.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston.services.events import Emit
from houston.errors import PreflightError
from houston.services.events import info
from houston.services.events import null_emit
import time

from houston.services.k8s import ask
from houston.services.k8s import capabilities
from houston.services.k8s import context as kubectx
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import release as kuberelease
from houston.services.k8s.certmanager import CA_ISSUER
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, INSTALL_TIMEOUT

#: The ingress controller houston installs when a cluster has none, and where. The
#: official Rocket.Chat guide's own example -- `helm install traefik traefik/traefik -n
#: traefik --create-namespace` -- so a cluster houston filled in looks like a cluster
#: somebody followed the guide on.
#:
#: THE CHART'S DEFAULT SERVICE TYPE IS LEFT ALONE, and that is the whole reason no
#: NodePort is configured anywhere. `helm show values traefik/traefik` renders
#: `type: LoadBalancer`; on a cluster with a provider it gets an address and the
#: cluster owns :443, and on one without it stays `<pending>` while Kubernetes
#: allocates NodePorts anyway. `ingress_endpoint` reads whichever exists. Forcing
#: NodePort would deviate from the guide to no purpose.
INGRESS_REPO = "traefik"

INGRESS_REPO_URL = "https://traefik.github.io/charts"

INGRESS_CHART = f"{INGRESS_REPO}/traefik"

INGRESS_RELEASE = "traefik"

INGRESS_NAMESPACE = "traefik"

INGRESS_CLASS_TRIES = 30

INGRESS_CLASS_INTERVAL = 2.0

def _install_ingress_controller(context, emit):
    """Install ingress-nginx and wait for its rollout."""
    info(emit, f"no ingress controller in {context!r} — installing {INGRESS_CHART} "
               f"into {INGRESS_NAMESPACE} (once per cluster, the guide's own command)",
         phase="tls", pct=12)
    kube.run(["helm", "repo", "add", INGRESS_REPO, INGRESS_REPO_URL, "--force-update"],
        timeout=APPLY_TIMEOUT, env=kubeexec.helm_env(context))
    kube.run(["helm", "repo", "update", INGRESS_REPO], timeout=APPLY_TIMEOUT,
        env=kubeexec.helm_env(context))
    # Same blast radius as the operator and the monitoring stack: one shared release,
    # so a killed install wedges it for every later workspace on this cluster.
    kuberelease.clear_pending_release(INGRESS_RELEASE, INGRESS_NAMESPACE, context, emit=emit)
    # DELIBERATELY NOT `--wait`, and NOT the rollback flag either -- which implies it.
    # Helm's readiness check for a `Service` of type LoadBalancer waits for
    # `status.loadBalancer.ingress` to be populated, and this chart's Service is a
    # LoadBalancer by default. On a cluster with no provider that never happens, so
    # `--wait` cannot succeed on precisely the cluster houston is installing into.
    # Measured on k3s started with `--disable servicelb`:
    #
    #     Error: release traefik failed, and has been uninstalled due to atomic
    #     being set: context deadline exceeded
    #
    # Five minutes, then a rollback, on an install whose three pods were fine. Same
    # shape and same remedy as `ensure_monitoring`, whose comment says it first: apply
    # without waiting, then wait for the thing that actually matters.
    res = kube.run(["helm", "upgrade", "--install", INGRESS_RELEASE, INGRESS_CHART,
               "--kube-context", context, "-n", INGRESS_NAMESPACE,
               "--create-namespace", "--timeout", "5m"],
              timeout=INSTALL_TIMEOUT, env=kubeexec.helm_env(context))
    if res.returncode != 0:
        raise CreateFailedError(
            f"could not install an ingress controller into {context!r}: " + ask.why(res))
    # The controller itself, which `--wait` would have covered had it been usable.
    kube.run(["kubectl", "--context", context, "-n", INGRESS_NAMESPACE, "rollout", "status",
         f"deployment/{INGRESS_RELEASE}", "--timeout=180s"],
        timeout=INSTALL_TIMEOUT, own=vocab.is_ours(context))


def _adopt_or_install_ingress(context, distribution, emit, invited, prefer, sleep):
    """Adopt the cluster's ingress class if it has one, install ingress-nginx if not."""
    seen = capabilities.ingress_classes(context)
    if seen is None:
        raise DockerError(
            f"could not read the IngressClasses in cluster {context!r}, so houston "
            f"cannot tell whether it has an ingress controller. Check the credential "
            f"in your kubeconfig — refusing to guess, because 'I cannot ask' and "
            f"'there is none' are different answers.")
    if seen and prefer:
        # NAMED BY THE OPERATOR, and refused rather than silently ignored. Somebody who
        # passes `--ingress-class alb` and gets nginx has been overruled without being
        # told, which is worse than an error.
        if prefer not in seen:
            raise PreflightError(
                f"cluster {context!r} has no IngressClass named {prefer!r}. It has: "
                + (", ".join(seen) or "none") + ".")
        info(emit, f"ingress: using {prefer!r} as asked", phase="tls")
        return prefer
    if len(seen) > 1:
        # SAID OUT LOUD, because a choice among several is a decision and this is the
        # only place it is visible. `ingress_classes` puts the cluster's own default
        # first; where there is no default the order is by name, which is arbitrary but
        # at least the same every time.
        info(emit, f"ingress: adopting {seen[0]!r} — this cluster has "
                   + ", ".join(seen)
                   + ". `--ingress-class` names a different one.", phase="tls")
        return seen[0]
    if seen:
        info(emit, f"ingress: adopting {seen[0]!r}, already in this cluster",
             phase="tls")
        return seen[0]
    if not invited and not kubectx.is_local_cluster(distribution
                                            or kubectx.distribution_of(context)):
        raise PreflightError(
            f"cluster {context!r} has no ingress controller, and it is not on this "
            f"machine, so houston will not install one: the chart's Service is a "
            f"LoadBalancer and that provisions a real load balancer in your cloud "
            f"account. Install one yourself and houston will adopt it:\n"
            f"    helm install {INGRESS_RELEASE} {INGRESS_CHART} "
            f"-n {INGRESS_NAMESPACE} --create-namespace")
    _install_ingress_controller(context, emit)
    # THE CLASS, NOT THE RELEASE. helm returning means the Deployment is ready; the
    # IngressClass is a separate object and the chart creates it, so a create that
    # went straight on to reading `pre.ingress_classes` would find none and refuse for
    # want of the thing it had just installed. Measured on a fresh k3s: the Service
    # appeared within five seconds of the release and the class a moment behind it.
    for attempt in range(INGRESS_CLASS_TRIES):
        found = capabilities.ingress_classes(context)
        if found:
            info(emit, f"ingress: installed {found[0]!r}", phase="tls")
            return found[0]
        if attempt < INGRESS_CLASS_TRIES - 1:
            sleep(INGRESS_CLASS_INTERVAL)
    raise CreateFailedError(
        f"{INGRESS_CHART} installed into {context!r} but no IngressClass appeared, so "
        f"nothing would route to this workspace. `kubectl get ingressclass` and "
        f"`kubectl -n {INGRESS_NAMESPACE} get pods`.")


def ensure_ingress(*, context: str, distribution: str = "", invited: bool = False,
                   prefer: str = "", emit: Emit = null_emit, sleep=time.sleep) -> str:
    """The IngressClass to use. Adopts one if the cluster has it, installs if not.

    `invited=True` means a human asked for this cluster to be set up (`cluster
    prepare`) rather than houston reaching for an ingress on the way to booting a
    workspace. Locality was standing in for consent in the guard below; installing a
    LoadBalancer Service into somebody else's cluster uninvited is the thing to avoid,
    and being asked to is not that.

    ADOPTING COMES FIRST, and not only to save work: the ingress controller is the
    component whose behaviour a support case is usually about, so a cluster that
    already runs nginx must keep running nginx. Installing Traefik over the top would
    reproduce the wrong thing in exactly the dimension that matters.

    Installing is therefore only for a cluster that has NONE -- k3s started with
    `--disable traefik`, a bare kubeadm, or houston's own fresh kind cluster, where
    `--https` used to be a dead end.

    **Only on a cluster that is on this machine.** An ingress controller's Service is
    a LoadBalancer by chart default, and on a managed cluster that provisions a real
    cloud load balancer -- a billable resource, created implicitly, in somebody's
    account. `.docs/design/kubernetes-cluster-model.md` already decided that one:
    "Never create a billable cloud resource implicitly." So a remote cluster is told
    what to run instead.

    **Never removed.** `remove_operator` and `remove_monitoring` are reference-counted
    and reclaim what houston installed; this is not, deliberately. An ingress
    controller serves every Ingress in the cluster, including ones houston knows
    nothing about, and taking the box's ingress away on a `down --volumes` would be a
    far bigger surprise than leaving it.
    """
    return _adopt_or_install_ingress(context, distribution, emit, invited, prefer, sleep)

def ingress_values(host: str, *, ingress_class: str, secret_name: str,
                   issuer: str = CA_ISSUER) -> dict:
    """The official guide's ingress block, verbatim in shape.

    From docs.rocket.chat/docs/deploy-with-kubernetes:

        host: <domain.xyz>
        ingress:
          enabled: true
          ingressClassName: traefik
          annotations:
            cert-manager.io/cluster-issuer: production-cert-issuer
          tls:
            - secretName: rckube
              hosts: [<domain.xyz>]

    `host` is returned alongside because the chart uses it for BOTH the Ingress rule
    host and its own ROOT_URL -- see `values_for`, where passing a URL here once
    rendered `https://http://localhost:32812`.

    The chart builds the Ingress; houston hand-writes none. That matters beyond
    tidiness: the chart's own template is what path-splits `/sockjs` and `/websocket`
    to `<release>-ddp-streamer` when microservices are on, and emulating a template
    is the signal that the layer is wrong. Verified by rendering chart 7.0.2 with
    exactly this block.
    """
    return {
        "host": host,
        "ingress": {
            "enabled": True,
            "ingressClassName": ingress_class,
            "annotations": {"cert-manager.io/cluster-issuer": issuer},
            "tls": [{"secretName": secret_name, "hosts": [host]}],
        },
    }
