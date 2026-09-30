"""Can this cluster be reached, and if not, WHY.

Tier k2, read-only. `Reach` classifies what came back into four states, and the distinction
between them is the whole point: refused credentials mean the cluster is up and this is
a permissions problem; no kubeconfig entry is not a statement about the cluster at all;
and nothing answering is the only one that might mean it is gone.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import CONTEXT, PROBE_TIMEOUT

#: `reach()` answers. Four, because the probe can fail in four ways that need four
#: different things done about them, and collapsing them to a bool sent people to
#: check a healthy cluster three separate times in one day of live testing.
REACH_OK = "ok"

REACH_DENIED = "denied"

REACH_NO_CONTEXT = "no-context"

REACH_DOWN = "down"

#: What the API server says when it is answering and refusing. EKS phrases it two
#: ways depending on which client asks -- `kubectl get --raw` gets the first, the
#: discovery client the second -- and both were observed on one cluster on the same
#: afternoon, so matching only one of them is matching none of them half the time.
_DENIED_MARKS = (
    "unauthorized",
    "must be logged in",
    "asked for the client to provide credentials",
    "forbidden",
    "error from server (forbidden)",
)

#: What kubectl says when the kubeconfig has never heard of the context. NOT a
#: statement about the cluster: this is the answer for a perfectly healthy cluster
#: that nobody has run `aws eks update-kubeconfig` for on this box, and reading it as
#: "the cluster is down" is how `cluster delete` came to report an ACTIVE cluster as
#: not answering.
#:
#: TWO PHRASINGS, both observed on this box on the same day: `kubectl get --raw`
#: answers `error: context "x" does not exist`, while the client-config path answers
#: `Error in configuration: context was not found for specified context: x`. Matching
#: one of them is matching none of them half the time, which is why these are patterns
#: rather than the substring list the denied marks can afford to be.
_NO_CONTEXT_PATTERNS = (
    re.compile(r"context .*(?:does not exist|was not found)"),
    re.compile(r"no context exists with the name"),
)

@dataclass
class Reach:
    """Whether the API server answers, and when it does not, WHY it did not.

    The three-answer rule this module is governed by, applied to reachability. A
    probe that comes back false is not one fact, it is four, and they are not
    interchangeable:

      REACH_OK          the cluster answered
      REACH_DENIED      it answered and refused us -- an RBAC or access-entry problem,
                        and the cluster is perfectly healthy
      REACH_NO_CONTEXT  this box has no kubeconfig entry for it -- also not a
                        statement about the cluster
      REACH_DOWN        nothing answered: stopped, deleted, or unroutable from here

    Only the last one means "check the cluster", and it was the only advice given for
    all four. MEASURED, three times in one day: `cluster status` told an engineer to
    check an ACTIVE cluster that was merely refusing them; `cluster delete` said an
    ACTIVE cluster "is not answering" when the real cause was a fresh HOUSTON_HOME
    with no kubeconfig entry; and the original kubeconfig-resolution defect produced
    an error telling the reader to run the command they had just run.
    """
    status: str = REACH_DOWN
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status == REACH_OK

    @property
    def denied(self) -> bool:
        """Answered, and said no. The cluster is up; the credential is the problem."""
        return self.status == REACH_DENIED

    def why(self) -> str:
        """One sentence naming the actual cause, for a refusal message to carry."""
        if self.status == REACH_OK:
            return ""
        if self.status == REACH_DENIED:
            return ("it answered and refused these credentials, so the cluster is up "
                    "and this is a permissions problem")
        if self.status == REACH_NO_CONTEXT:
            return ("this machine has no kubeconfig entry for it, which is not a "
                    "statement about the cluster")
        return "nothing answered: it may be stopped, deleted, or unreachable from here"

    def advice(self, context: str = "") -> str:
        """What to actually do about it. Empty when there is nothing to say."""
        if self.status == REACH_DENIED:
            return (" An EKS cluster grants Kubernetes access separately from IAM: ask "
                    "whoever created it to run `aws eks create-access-entry`, or check "
                    "`kubectl auth whoami`.")
        if self.status == REACH_NO_CONTEXT:
            if context.startswith("arn:aws:eks:"):
                return (" For an EKS cluster, `aws eks update-kubeconfig --name "
                        "<cluster> --region <region>` writes it.")
            return " `kubectl config get-contexts` lists the ones this box knows."
        return ""

def reach(context: str = CONTEXT,
          timeout: float = PROBE_TIMEOUT) -> Reach:
    """Probe the API server and classify what came back. Never raises."""
    res = kube.run(["kubectl", "--context", context, "get", "--raw", "/readyz"],
              own=vocab.is_ours(context), timeout=timeout)
    if res.returncode == 0 and "ok" in (res.stdout or "").lower():
        return Reach(status=REACH_OK)
    # BOTH STREAMS. kubectl writes its configuration errors to stderr and some server
    # errors to stdout, and which one carries the reason varies by subcommand -- so a
    # classifier that reads one of them misfiles the other as REACH_DOWN, which is the
    # exact conflation this type exists to end.
    said = f"{res.stderr or ''}\n{res.stdout or ''}".lower()
    detail = (res.stderr or res.stdout or "").strip().splitlines()
    first = detail[0].strip() if detail else ""
    for pat in _NO_CONTEXT_PATTERNS:
        if pat.search(said):
            return Reach(status=REACH_NO_CONTEXT, detail=first)
    for mark in _DENIED_MARKS:
        if mark in said:
            return Reach(status=REACH_DENIED, detail=first)
    return Reach(status=REACH_DOWN, detail=first)

def reachable(context: str = CONTEXT,
              timeout: float = PROBE_TIMEOUT) -> bool:
    """Whether the API server answers. A cluster can exist and not respond --
    a stopped Docker, a half-deleted cluster, a machine that just woke up.

    KEPT AS A BOOL on purpose. Most callers are resolution order -- `if ours and
    reachable(ours)` -- where the four-way answer would be noise and the only question
    is whether this candidate can be used. Callers that put the result in front of a
    person use `reach()` instead, because that is where the difference is the whole
    value.
    """
    return reach(context, timeout=timeout).ok

def helm_reachable(context: str = CONTEXT,
                   timeout: float = PROBE_TIMEOUT) -> str:
    """Whether HELM can reach the cluster, and if not, what it said.

    Asked SEPARATELY from `reachable()` because houston drives two clients and they
    do not share a code path: kubectl gets `--context` and, for an adopted cluster,
    whatever kubeconfig the user has; helm gets the same context through
    `helm_env`. They can disagree, and when they do the create is already four
    minutes in.

    Measured on this box. `~/.kube/config` held the server CA and client certificate
    of a PREVIOUS k3s installation -- `k3s-server-ca@1787626086` where the live
    cluster ran `@1787660620`. kubectl was completely happy: `get ns`, `auth whoami`
    as system:admin, the whole MongoDB phase of a create. Helm refused every call
    with

        Error: kubernetes cluster unreachable: Get "https://127.0.0.1:6443/version":
        tls: failed to verify certificate: x509: certificate signed by unknown authority

    so `up --runtime kubernetes` built a namespace, a StatefulSet, a PersistentVolume
    and an initiated replica set, then died at the chart and rolled all of it back.
    The error named neither the cause nor the cure, and `doctor` said the cluster was
    fine -- because doctor only ever asked kubectl.

    Returns "" when helm is happy, else the line worth showing. `helm list` and not
    `version`: it needs a real authenticated round trip, which is the thing in doubt.
    """
    if not tools.which("helm"):
        return ""                       # a missing helm is already its own check
    # `helm_env`, not `own=`: helm's own state is always houston's while the
    # kubeconfig belongs to whoever owns the cluster -- the distinction that module
    # docstring exists for, and the one this probe has to reproduce exactly or it
    # would be testing a different client than the create uses.
    res = kube.run(["helm", "list", "--kube-context", context, "-n", "default",
               "--max", "1"], env=kubeexec.helm_env(context), timeout=timeout)
    if res.returncode == 0:
        return ""
    why = (res.stderr or res.stdout or "").strip().splitlines()
    return why[0][:300] if why else f"helm exited {res.returncode}"
