"""The ONE way this package invokes anything, and the environments it invokes under.

Tier k1. `run()` is the single invocation funnel and it NEVER raises: an `OSError` or
`SubprocessError` becomes a synthetic `CompletedProcess(returncode=127)`, so every caller
reads a return code rather than choosing between an exception and a result.

The two environments are the seam's other half. `owned_env` cannot reach the user's own
client state and is used for anything touching houston's OWN cluster; `user_env` obeys an
explicitly set KUBECONFIG untouched and otherwise names the standard path.
"""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

from houston import config
from houston import exec as subprocess
from houston.services.k8s import names as vocab
from houston.services.k8s.names import PROBE_TIMEOUT

def owned_kubeconfig() -> Path:
    """houston's OWN kubeconfig, under HOUSTON_HOME.

    `kind create cluster` writes `~/.kube/config` AND switches current-context to
    the cluster it just made. Without this, creating a workspace would silently
    redirect the user's own `kubectl` -- somebody working in their k3s cluster
    runs `houston up` and their next `kubectl get pods` answers from somewhere
    else. That is the one way cluster creation genuinely disturbs existing work,
    and it is not acceptable for a tool that is supposed to be disposable.

    Adopted from PR #3, which also redirects every Helm home: pinning only
    repositories.yaml still leaves cache and data writes in the user's home.
    """
    return config.home() / "clients" / "kubernetes" / "config"

def owned_env() -> dict[str, str]:
    """An environment whose client state cannot reach the user's home.

    Used for anything touching houston's OWN cluster. Discovery -- finding the
    cluster you already have -- deliberately does NOT use this, because the whole
    point there is to read the config you already set up.
    """
    root = config.home() / "clients"
    helm = root / "helm"
    kubeconfig = owned_kubeconfig()
    for directory in (kubeconfig.parent, helm / "cache", helm / "config",
                      helm / "data", helm / "cache" / "repository"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = os.environ.copy()
    env.update({
        "KUBECONFIG": str(kubeconfig),
        "HELM_CACHE_HOME": str(helm / "cache"),
        "HELM_CONFIG_HOME": str(helm / "config"),
        "HELM_DATA_HOME": str(helm / "data"),
        "HELM_REPOSITORY_CONFIG": str(helm / "config" / "repositories.yaml"),
        "HELM_REPOSITORY_CACHE": str(helm / "cache" / "repository"),
    })
    return env

def helm_env(context: str) -> dict[str, str]:
    """Helm's own state is ALWAYS houston's; the kubeconfig belongs to whoever owns the
    cluster.

    `owned_env` sets both at once, and that conflation was a real defect. Every helm call
    was either fully owned or not at all, so on a cluster houston ADOPTED the chart repo
    went into houston's Helm home (`ensure_repo`, `own=True`) while the install that
    needed it read the USER's (`vocab.is_ours(context)` is False there). Two different
    repositories.yaml, and the create failed at 60% -- after the namespace, the operator
    and MongoDB had all been built -- with

        helm install failed: Error: repo rocketchat not found

    then rolled the namespace back. The MongoDB operator path happened to work only
    because BOTH its halves used the user's home: consistent, and also wrong, because it
    wrote repositories into the home `owned_env` exists to keep houston out of.

    So HELM_* always points at houston's directories and KUBECONFIG is left as the user
    has it unless the cluster is ours. kubectl needs no equivalent: it has no client
    state worth redirecting, and `own=vocab.is_ours(context)` already picks its kubeconfig.
    """
    env = owned_env()
    if not vocab.is_ours(context):
        outside = os.environ.get("KUBECONFIG")
        if outside is None:
            env.pop("KUBECONFIG", None)
        else:
            env["KUBECONFIG"] = outside
    return env

def user_env() -> dict[str, str] | None:
    """The environment for talking to a cluster houston does NOT own, or None.

    None means "inherit unchanged", which is what every non-owned call used to do --
    and it made houston's idea of "your kubeconfig" depend on which `kubectl` BINARY
    is installed rather than on the kubeconfig itself.

    MEASURED, on a box where that diverges: `kubectl` was a symlink to k3s, whose
    embedded client reads `/etc/rancher/k3s/k3s.yaml` when KUBECONFIG is unset. `aws
    eks update-kubeconfig` had just written the cluster into `~/.kube/config`, the
    standard path, and the two files never met -- so `--context <the arn>` was refused
    with a message telling the operator to run the exact command they had just run.
    The context existed, was correct, and was invisible.

    So the standard path is named explicitly when nothing else has been said. On a box
    with ordinary kubectl this changes nothing, because it is already the default; on
    one where the client disagrees, it makes houston agree with the AWS CLI, which is
    what wrote the file.

    Two deliberate non-actions. An operator who has SET `KUBECONFIG` has said which
    files they mean, and that is obeyed untouched. And a missing `~/.kube/config` is
    left alone rather than forced, because pointing kubectl at a file that does not
    exist would take away whatever default it does have.
    """
    if os.environ.get("KUBECONFIG"):
        return None
    standard = Path.home() / ".kube" / "config"
    if not standard.is_file():
        return None
    env = os.environ.copy()
    env["KUBECONFIG"] = str(standard)
    return env

def env_for(context: str) -> dict[str, str] | None:
    """The environment for talking to `context`, whoever owns it.

    ONE function, because the rule was written out at EIGHT call sites as
    `owned_env() if vocab.is_ours(context) else None` and a fix to it reached exactly one.
    When `user_env()` was added to stop houston's view of a kubeconfig depending on
    which kubectl BINARY is installed, `kube.run()` got it and the seven places that build
    their own subprocess -- apply, helm install and upgrade, port-forward, logs, exec
    in and exec out -- did not. The preflight would pass on an EKS context and the
    first `kubectl apply` would fail on the same missing context the preflight had
    just found.

    A rule repeated at eight sites is a rule that will be fixed at one of them.
    """
    return owned_env() if vocab.is_ours(context) else user_env()

def run(argv: list[str], *, timeout: float = PROBE_TIMEOUT, own: bool = False,
        env: dict[str, str] | None = None,
        input: str | None = None) -> subprocess.CompletedProcess:
    """Run a kind/kubectl/helm command. Never raises; the caller reads returncode.

    `own=True` runs against houston's own client state, so nothing it does can
    reach or rewrite the user's `~/.kube/config` or Helm homes. Never guessed at a
    call site: each function derives it from the context it is targeting, so
    forgetting it is not a thing that can happen.

    `input` is a document on stdin (`kubectl apply -f -`), as the TypeScript seam's is.

    A preflight that raises on a missing binary or an unreachable API server would
    have to be wrapped at every call site, and one forgotten wrapper takes down
    `doctor` -- which is the command someone runs precisely because things are
    already wrong.
    """
    try:
        return subprocess.run(argv, capture_output=True, text=True, input=input,
                              timeout=timeout, check=False,
                              env=env if env is not None
                              else (owned_env() if own else user_env()))
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(argv, returncode=127, stdout="", stderr=str(exc))

# A property lookup is deliberately part of this boundary.  Python tests could
# replace the module global ``run`` and intercept sibling functions, but emitted
# TypeScript cannot replace a module-local binding.  Keeping the callable on one
# exported object makes the same dependency injectable on both sides of the port.
kube = SimpleNamespace(run=run)
