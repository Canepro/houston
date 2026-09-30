"""A three-valued answer, because a refused read is not an empty one.

Tier k1. `Answer` is PRESENT, ABSENT or REFUSED, and its `__bool__` deliberately raises
`TypeError` so a caller cannot write `if ask_object(...)` and silently treat "the cluster
would not say" as "it is not there". That conflation is the defect `namespace_labels`
was fixed for in v0.70.9 and the one this whole vocabulary exists to make unwritable.

Its own module so the invariant has one file to walk.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from houston.errors import DockerError
from houston.services.k8s import exec as kubeexec
from houston import exec as subprocess
from houston.services.k8s import names as vocab
from houston.services.k8s.names import PROBE_TIMEOUT

#: The three answers an external tool can give about a thing, and the reason this
#: module has a type for them at all. `namespace_labels` has said it since it was
#: written -- "'I could not ask' and 'it is not there' are different answers and only
#: one of them is safe to act on" -- and it was the ONLY function that implemented it.
#: Five others collapsed the three back to two, each by reading a non-zero exit as a
#: negative answer, and that one habit produced a `down --volumes` that deleted a
#: workspace's record while its namespace was still there, a `prune` that reported
#: namespaces reclaimed that were still Terminating, and a `doctor` that reported "0
#: nodes, no StorageClass, no ingress" for a cluster with all three.
#:
#: MEASURED, not assumed: kubectl exits 1 for BOTH "namespace absent" and "context
#: does not exist", so no threshold on the exit code can separate them. `.docs/design/
#: k8s-answer-contract.md` has the runs.
REFUSED, ABSENT, PRESENT = "refused", "absent", "present"

#: The three answers an external tool can give about a thing, and the reason this
#: module has a type for them at all. `namespace_labels` has said it since it was
#: written -- "'I could not ask' and 'it is not there' are different answers and only
#: one of them is safe to act on" -- and it was the ONLY function that implemented it.
#: Five others collapsed the three back to two, each by reading a non-zero exit as a
#: negative answer, and that one habit produced a `down --volumes` that deleted a
#: workspace's record while its namespace was still there, a `prune` that reported
#: namespaces reclaimed that were still Terminating, and a `doctor` that reported "0
#: nodes, no StorageClass, no ingress" for a cluster with all three.
#:
#: MEASURED, not assumed: kubectl exits 1 for BOTH "namespace absent" and "context
#: does not exist", so no threshold on the exit code can separate them. `.docs/design/
#: k8s-answer-contract.md` has the runs.
REFUSED, ABSENT, PRESENT = "refused", "absent", "present"

#: The three answers an external tool can give about a thing, and the reason this
#: module has a type for them at all. `namespace_labels` has said it since it was
#: written -- "'I could not ask' and 'it is not there' are different answers and only
#: one of them is safe to act on" -- and it was the ONLY function that implemented it.
#: Five others collapsed the three back to two, each by reading a non-zero exit as a
#: negative answer, and that one habit produced a `down --volumes` that deleted a
#: workspace's record while its namespace was still there, a `prune` that reported
#: namespaces reclaimed that were still Terminating, and a `doctor` that reported "0
#: nodes, no StorageClass, no ingress" for a cluster with all three.
#:
#: MEASURED, not assumed: kubectl exits 1 for BOTH "namespace absent" and "context
#: does not exist", so no threshold on the exit code can separate them. `.docs/design/
#: k8s-answer-contract.md` has the runs.
REFUSED, ABSENT, PRESENT = "refused", "absent", "present"

@dataclass(frozen=True)
class Answer:
    """What the cluster said about one thing: PRESENT, ABSENT or REFUSED.

    `absent` is a fact the cluster asserted and is safe to act on. `refused` means
    nobody knows -- a wrong context, an expired credential, an RBAC denial, an API
    server that is not answering -- and acting on it as though it meant "no" is the
    defect this type exists to make unwriteable.

    There is deliberately no usable truthiness: `__bool__` raises. `if answer:` would
    be the very collapse being prevented, so a caller has to name which state it means.
    """

    state: str
    doc: dict | None = None
    res: subprocess.CompletedProcess | None = None

    def __bool__(self) -> bool:
        raise TypeError("Kubernetes Answer has three states; test .present, .absent or .refused")

    @property
    def present(self) -> bool:
        return self.state == PRESENT

    @property
    def absent(self) -> bool:
        return self.state == ABSENT

    @property
    def refused(self) -> bool:
        return self.state == REFUSED

    @property
    def items(self) -> list[dict]:
        """The objects of a list read; empty for a list that legitimately holds none.

        Empty is only ever "the cluster has none of these" -- a refused read never
        reaches here, because `refused` is a separate state and not an empty list.
        That equivalence is exactly what made `doctor` report "0 nodes".
        """
        return list(((self.doc or {}).get("items")) or [])

    def why(self, *, limit: int = 400) -> str:
        return why(self.res, limit=limit) if self.res is not None else ""

    def require(self, what: str, *, context: str) -> "Answer":
        """Raise unless the cluster actually answered. For paths that must not guess.

        The wording is `namespace_labels`' own, because it was right: it names the
        cluster, quotes the tool, and says why a guess is not on offer.
        """
        if self.refused:
            raise DockerError(
                f"could not ask cluster {context!r} about {what}: " + self.why()
                + " — refusing to guess, because 'I cannot ask' and 'it is not "
                  "there' are different answers and only one of them is safe to "
                  "act on")
        return self

def _classify(res: subprocess.CompletedProcess, *, single: bool) -> Answer:
    """Turn a finished kubectl into one of the three answers.

    The rule, and the only rule: **a zero exit means the API server answered.**
    Absence is then read from the PAYLOAD -- empty for a single object fetched with
    `--ignore-not-found` -- and never from the exit code.
    """
    if res.returncode != 0:
        # SECONDARY, AND ONLY EVER SECONDARY: the API server's own reason code.
        # `--ignore-not-found` makes an absent object exit 0 with an empty payload, so
        # reaching here at all means either a kubectl older than the flag or a call
        # site that did not pass it -- and in both cases the server's `(NotFound)` is
        # still a real assertion of absence, so throwing it away would be its own bug.
        #
        # The flag stays the primary test because THIS test was once the only one and
        # got it wrong: the first cut matched `"not found"`, which also matches
        # `Error in configuration: context was not found for specified context: ...`
        # -- a kubeconfig problem read as an absent namespace, the exact confusion
        # this module exists to prevent. Only the API server says
        # `Error from server (NotFound)`; a client-side configuration error never does.
        if single and "fromserver(notfound)" in why(res).lower().replace(" ", ""):
            return Answer(ABSENT, None, res)
        return Answer(REFUSED, None, res)
    raw = (res.stdout or "").strip()
    if single and not raw:
        # `--ignore-not-found` turns "not there" into exit 0 with nothing on stdout,
        # which is the whole reason it is passed. `-o json` rather than a jsonpath
        # because a jsonpath can be legitimately empty for an object that EXISTS --
        # a namespace with no labels reads identically to no namespace at all, and
        # that collision would rebuild the bug inside the fix.
        return Answer(ABSENT, None, res)
    try:
        doc = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        # The server answered and we cannot parse it. That is not absence.
        return Answer(REFUSED, None, res)
    return Answer(PRESENT, doc if isinstance(doc, dict) else {}, res)

def ask_object(kind: str, name: str, *, context: str, namespace: str = "",
               timeout: float = PROBE_TIMEOUT) -> Answer:
    """Ask about ONE named object: PRESENT with its document, ABSENT, or REFUSED."""
    argv = ["kubectl", "--context", context]
    if namespace:
        argv += ["-n", namespace]
    argv += ["get", kind, name, "--ignore-not-found", "-o", "json"]
    return _classify(kubeexec.kube.run(argv, own=vocab.is_ours(context), timeout=timeout), single=True)

def ask_list(kind: str, *, context: str, namespace: str = "",
             selector: str = "", all_namespaces: bool = False,
             timeout: float = PROBE_TIMEOUT) -> Answer:
    """Ask for a COLLECTION: PRESENT with `.items` (possibly empty), or REFUSED.

    There is no ABSENT for a list. A cluster that holds no StorageClass answers with
    an empty collection and exit 0; a cluster nobody could reach is REFUSED. Reading
    those as the same empty list is finding F-010.

    `all_namespaces` is `-A`, and it is NOT the default for a reason worth stating:
    without it kubectl reads the CURRENT namespace, so a namespaced kind asked for
    without either flag answers about `default` alone -- an empty, exit-0, entirely
    believable "there are none of those here". Every existing caller asks for a
    cluster-scoped kind (nodes, ingressclass, storageclass), where the flag is
    irrelevant; the first caller that wanted a namespaced one needed it.
    """
    argv = ["kubectl", "--context", context]
    if namespace and not all_namespaces:
        argv += ["-n", namespace]
    argv += ["get", kind, "-o", "json"]
    if all_namespaces:
        # AFTER the subcommand, and that is not cosmetic. `--namespace` is a global
        # flag and may precede `get`; `--all-namespaces` belongs to `get` itself, and
        # placed before it kubectl answers "flags cannot be placed before plugin
        # name: --context" -- which `Answer` correctly refused to read as "this
        # cluster has no Services". Found by it doing exactly that.
        argv += ["-A"]
    if selector:
        argv += ["-l", selector]
    return _classify(kubeexec.kube.run(argv, own=vocab.is_ours(context), timeout=timeout), single=False)

def why(res, *, limit: int = 400) -> str:
    """The line that explains a failure, not the first 400 characters of noise.

    Written after a `helm install` failure reported two harmless warnings and hid
    its own reason. Every tool here puts its diagnostics FIRST and its error LAST --
    helm emits klog warnings then `Error: ...`, kubectl emits deprecation notices
    then the message -- so taking a prefix reliably shows the least useful part.

    Prefers a line that announces itself as an error; falls back to the last
    non-empty line, which is where these tools put it.
    """
    text = f"{getattr(res, 'stderr', '') or ''}\n{getattr(res, 'stdout', '') or ''}"
    raw = [ln for ln in text.splitlines() if ln.strip()]
    lines = [ln.strip() for ln in raw]
    if not lines:
        return "no reason given"
    named = [i for i, ln in enumerate(lines)
             if re.match(r"^(error|Error|ERROR|fatal|Fatal)\b", ln)
             or "error:" in ln.lower()]
    # Warnings are not errors, however loudly they are printed. klog prefixes them
    # with I/W and a timestamp, and helm's install failure sits after them.
    named = [i for i in named if not re.match(r"^[IWD]\d{4} ", lines[i])]
    at = named[-1] if named else len(lines) - 1
    # THE CONTINUATION LINES ARE THE REASON, and they were being thrown away. This
    # docstring's premise -- diagnostics first, error last -- holds for klog and
    # inverts for a Helm TEMPLATE error, which announces the location on the `Error:`
    # line and puts the cause on the indented lines after it:
    #
    #     Error: UPGRADE FAILED: rocketchat/templates/podmonitor.yaml:24:18
    #       executing "..." at <.Values.podMonitor.enabled>:
    #         nil pointer evaluating interface {}.enabled
    #
    # So the file and line survived and "nil pointer" did not, which is why an
    # upgrade that failed for a knowable reason read as unexplained. Indentation is
    # the signal helm itself uses, and a line that starts a new diagnostic is never
    # indented.
    chosen = [lines[at]]
    for nxt in range(at + 1, len(raw)):
        if not raw[nxt][:1].isspace():
            break
        chosen.append(lines[nxt])
    return " ".join(chosen)[:limit]
