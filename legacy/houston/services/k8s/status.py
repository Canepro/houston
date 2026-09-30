"""What the workload is doing right now: pods, their phases, and the failures
Kubernetes has already decided are terminal.

`terminal_pod_failure` exists so a mistyped version or an unreachable registry costs a
second rather than the full readiness timeout, and reports the cause rather than the
timeout.
"""
from __future__ import annotations

from houston.errors import DockerError
from houston.errors import NotReadyError
import json
from houston import exec as subprocess

from houston.services.k8s import ask
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import namespace as kubens
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, RELEASE

#: The workloads whose readiness `ready` is entitled to speak for: the ones the
#: official chart gives a real readinessProbe. `account`, `authorization` and
#: `presence` are deliberately NOT here -- the chart ships them with no probe at all,
#: so their pod-Ready is set the moment the container starts and attests nothing.
#: Waiting on it would add delay and buy no confidence.
READY_SELECTOR = ("app.kubernetes.io/name in "
                  "(rocketchat,rocketchat-ddp-streamer)")

def service_ready_addresses(namespace: str, *, context: str) -> dict[str, int] | None:
    """Ready endpoint count per Service in a namespace. `None` if it could not be read.

    **EndpointSlice, not Endpoints.** kubectl says it plainly on every call to the old
    one -- "v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1
    EndpointSlice" -- and `discovery.k8s.io/v1` has been GA since Kubernetes 1.21,
    which is this module's declared kubectl floor. So there is no version this tool
    supports where the new API is unavailable.

    A Service with pods behind it but no READY endpoints is the case worth having
    this for: readiness reads pod status and the port-forward targets the Deployment,
    so nothing on either path ever traverses the Service. A selector that matches
    nothing therefore looked exactly like a healthy workspace -- and the Kubernetes
    default deployment is microservices, where in-cluster Service traffic is what
    carries the product.
    """
    seen = ask.ask_list("endpointslices", context=context, namespace=namespace)
    if seen.refused:
        return None
    out: dict[str, int] = {}
    for slice_ in seen.items:
        svc = ((slice_.get("metadata") or {}).get("labels")
               or {}).get("kubernetes.io/service-name")
        if not svc:
            continue
        ready = sum(1 for e in (slice_.get("endpoints") or [])
                    if ((e.get("conditions") or {}).get("ready")))
        out[str(svc)] = out.get(str(svc), 0) + ready
    return out

def services_without_endpoints(name: str, *, context: str) -> list[str]:
    """Rocket.Chat Services in this workspace that no ready pod is behind.

    REPORTED, NOT GATED, and that is deliberate. Endpoints churn during a rollout, so
    a transient empty set is normal; making readiness depend on this would turn an
    ordinary restart into a workspace that never comes ready. And a false negative
    here -- a Service this cannot see, a chart that renames one -- would block every
    boot, which is a far worse failure than the one being detected.

    Empty list on any doubt: a namespace whose slices could not be read, or one with
    no Services at all, says nothing.
    """
    namespace = kubens.namespace_for(name)
    counts = service_ready_addresses(namespace, context=context)
    if counts is None:
        return []
    svcs = ask.ask_list("svc", context=context, namespace=namespace)
    if svcs.refused:
        return []
    bad = []
    for svc in svcs.items:
        meta = svc.get("metadata") or {}
        svc_name = str(meta.get("name") or "")
        spec = svc.get("spec") or {}
        # A Service with no selector is wired by hand (or is a headless alias) and has
        # no pods to be missing. ExternalName has no endpoints by definition.
        if not svc_name or not (spec.get("selector") or {}):
            continue
        if str(spec.get("type") or "") == "ExternalName":
            continue
        # THE SELECTOR, NOT THE LABELS, and this was wrong first time round: the
        # first version filtered on the Service's own
        # `app.kubernetes.io/instance` LABEL, and the chart does not set it on most
        # of them -- `rocketchat-ddp-streamer` carries only
        # `app.kubernetes.io/managed-by: Helm`. So the filter excluded every Service
        # it was meant to judge and the whole check was a silent no-op: it returned
        # [] for a workspace whose ddp-streamer Service had been deliberately broken.
        # Caught by breaking one on a live cluster, which is the only way it could
        # have been caught -- a stub would have answered whatever the test put in it.
        #
        # The SELECTOR carries the instance on every one of them, verified against a
        # real microservices workspace, and it excludes our hand-rolled `mongodb`
        # (selector `{"app": "mongodb"}`) without naming it.
        if (spec.get("selector") or {}).get(
                "app.kubernetes.io/instance") != RELEASE:
            continue
        if counts.get(svc_name, 0) == 0:
            bad.append(svc_name)
    return sorted(bad)

def workspace_ready(name: str, *, context: str) -> bool:
    """Whether every probed Rocket.Chat workload reports itself Ready.

    This used to read `items[0].status.containerStatuses[0].ready`, which over-claimed
    twice, and an audit caught both:

      * `items[0]` is ONE pod. With `--replicas 3` the workspace was called ready on
        the strength of the first pod alone.
      * Only the monolith container was consulted. On microservices, `ddp-streamer`
        carries the WebSocket -- the realtime half of Rocket.Chat -- and it was
        observed Running-but-not-Ready on a workspace `ready` had already reported as
        serving. A caller told "ready" could open the URL and find messages not
        arriving, which is the one failure this tool exists to reproduce, not cause.

    A Pending pod has no containerStatuses at all, so counting pods and comparing is
    what keeps "no statuses yet" from passing as "nothing failed".
    """
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "get", "pod", "-l", READY_SELECTOR, "-o", "json"],
              own=vocab.is_ours(context))
    if res.returncode != 0:
        return False
    try:
        pods = json.loads(res.stdout or "{}").get("items") or []
    except ValueError:
        return False
    if not pods:
        return False
    for pod in pods:
        statuses = (pod.get("status") or {}).get("containerStatuses") or []
        if not statuses:                      # Pending/ContainerCreating
            return False
        if not all(c.get("ready") for c in statuses):
            return False
    return True

#: Rocket.Chat's APPLICATION pods -- every replica of the monolith, and on
#: microservices the account, authorization, ddp-streamer and presence deployments
#: too. `-l` rather than a pod name so this follows a rollout.
#:
#: This was `app.kubernetes.io/name=rocketchat`, which is the MONOLITH deployment
#: alone. On microservices that silently omitted the four services that make the
#: deployment interesting -- ddp-streamer above all, since it carries the WebSocket,
#: so a realtime problem produced logs with nothing about realtime in them. Compose
#: has no service filter at all and shows everything, so the narrow selector was also
#: the two runtimes disagreeing.
#:
#: Selected by RELEASE with nats excluded, rather than by listing the four names: a
#: microservice the chart adds later is then included automatically, which a hardcoded
#: list would quietly miss. nats is the message bus, not Rocket.Chat, and its output
#: would drown the logs somebody opened to read Rocket.Chat's.
LOG_SELECTOR = (f"app.kubernetes.io/instance={RELEASE},"
                "app.kubernetes.io/name!=nats")

#: The MONOLITH Rocket.Chat deployment alone, and its container. Anything asking a
#: question about "Rocket.Chat itself" -- readiness, its environment -- wants this and
#: not the broad log selector: that one matches ddp-streamer and presence too, so
#: `items[0]` under it could answer with a microservice's environment instead of
#: Rocket.Chat's.
APP_SELECTOR = "app.kubernetes.io/name=rocketchat"

LOG_CONTAINER = "rocketchat"

def _pod_count(name: str, *, context: str, selector: str = LOG_SELECTOR) -> int:
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "get", "pods", "-l", selector, "-o", "name"],
              own=vocab.is_ours(context))
    if res.returncode != 0:
        return 1
    return len([ln for ln in (res.stdout or "").splitlines() if ln.strip()])

def log_process(name: str, *, context: str, tail: int = 200, follow: bool = True,
                selector: str = LOG_SELECTOR) -> subprocess.Process:
    """Stream Rocket.Chat's logs out of the cluster, shaped like the Compose one.

    A named function for the same reason `open_log_process` is one: it is the single
    kubectl call the log path makes, so a test can stand here without a cluster.

    `--prefix` matters more here than on Compose: with microservices or several
    replicas the lines come from different pods and are otherwise indistinguishable,
    which is exactly when someone is reading them. `--max-log-requests` is raised
    because kubectl refuses to follow more than five pods by default and a
    microservices workspace has more than five.
    """
    # No `-c`: the pods now selected have DIFFERENT container names (rocketchat,
    # ddp-streamer, presence...), so naming one would fail on the others. Each pod
    # here has a single container, so kubectl's default is the right one.
    argv = ["kubectl", "--context", context, "-n", kubens.namespace_for(name), "logs",
            "-l", selector, "--tail", str(int(tail)),
            "--max-log-requests", "20"]
    # `--prefix` ONLY when there is more than one pod to tell apart. It was
    # unconditional and that was wrong: Rocket.Chat pretty-prints its own log lines
    # in columns, and stamping "[pod/rocketchat-rocketchat-<hash>/rocketchat] " onto
    # the front of every one of them destroys exactly the formatting somebody opened
    # the logs to read. With a single pod the prefix names the only thing it could
    # be, so it is pure noise; with several it is the only way to tell them apart.
    if _pod_count(name, context=context, selector=selector) > 1:
        argv.append("--prefix")
    if follow:
        argv.append("-f")
    return subprocess.popen(argv, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1,
                            env=kubeexec.env_for(context))

def container_env(name: str, *, context: str,
                  selector: str = APP_SELECTOR) -> dict[str, str]:
    """Rocket.Chat's EFFECTIVE environment, read out of the running container.

    Compose answers this from the generated compose file. There is no such document
    here, and the helm values are only what houston asked for -- the chart adds its
    own, so the values are not the answer to "what is Rocket.Chat actually running
    with". The container is, so it is asked directly.
    """
    pod = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "get", "pod", "-l", selector, "-o",
               "jsonpath={.items[0].metadata.name}"], own=vocab.is_ours(context))
    # THE EXIT CODE, not just empty stdout. A refused read -- wrong context, RBAC,
    # a timeout -- also produces no stdout, so a HEALTHY running workspace was told
    # "no Rocket.Chat pod ... is it running?", which sends the reader to start
    # something that is already started. The exec below has always checked its own
    # return code; this call did not, and they are the same question.
    if pod.returncode != 0:
        raise DockerError(
            f"could not ask cluster {context!r} for {name!r}'s Rocket.Chat pod: "
            + ask.why(pod))
    target = (pod.stdout or "").strip()
    if not target:
        raise NotReadyError(
            f"no Rocket.Chat pod in {kubens.namespace_for(name)} to read the environment "
            f"from — is {name!r} running? (`houston start --name {name}`)")
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "exec", target, "-c", LOG_CONTAINER, "--", "env"],
              timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        raise NotReadyError(f"could not read the environment from {target}: "
                            + ask.why(res))
    out: dict[str, str] = {}
    for line in (res.stdout or "").splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value
    return out

def _parse_quantity(text: str) -> float:
    """A Kubernetes CPU or memory quantity as a plain number.

    CPU comes as millicores ("142m") or cores ("1"); memory as Ki/Mi/Gi. Returned as
    millicores and BYTES respectively, so the caller does the same arithmetic it does
    for Compose.
    """
    t = text.strip()
    if t.endswith("m"):
        return float(t[:-1] or 0)
    for suffix, mult in (("Ki", 1024), ("Mi", 1024 ** 2), ("Gi", 1024 ** 3),
                         ("K", 1000), ("M", 1000 ** 2), ("G", 1000 ** 3)):
        if t.endswith(suffix):
            return float(t[:-len(suffix)] or 0) * mult
    try:
        return float(t)
    except ValueError:
        return 0.0

def pod_metrics(name: str, *, context: str,
                selector: str = LOG_SELECTOR) -> list[dict]:
    """Per-pod CPU and memory, via `kubectl top`.

    Every Rocket.Chat application pod, which on microservices means the four services
    as well as the monolith deployment -- the same set Compose sums when it adds up
    `rocketchat`, `rocketchat-1`, `rocketchat-2`. Scoped to the monolith alone it
    would report two pods out of six and call it the workspace's resource use, which
    is the quietly-wrong number this function exists to avoid.

    Needs metrics-server, which kind does NOT ship. When it is absent the refusal
    says so and how to install it, rather than reporting zero -- a resource figure
    that is quietly wrong is worse than one that is missing, which is the same
    reasoning `stats` already applies to a container it cannot find.
    """
    # An EMPTY selector means the whole namespace, and the flag is dropped rather than
    # passed empty -- `stats` asks for that, because Compose sums every container in
    # the workspace and reporting only the Rocket.Chat pods made the two runtimes
    # measure different sets, omitting the database on the one where it is usually the
    # largest consumer.
    argv = ["kubectl", "--context", context, "-n", kubens.namespace_for(name),
            "top", "pods", "--no-headers"]
    if selector:
        argv[-1:-1] = ["-l", selector]
    res = kube.run(argv, timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        blob = (res.stderr or "") + (res.stdout or "")
        if "metrics" in blob.lower() or "not available" in blob.lower():
            # Both commands, because the second is not optional on kind: its
            # kubelet serves a self-signed certificate that metrics-server refuses
            # by default, so the install succeeds and never reports a metric. The
            # first version of this message mixed the helm flag into the kubectl
            # route, which is syntax that does not apply to what it just told the
            # user to run.
            raise NotReadyError(
                "this cluster has no metrics-server, so there is nothing to read "
                "CPU and memory from. Install it with:\n"
                "  kubectl apply -f https://github.com/kubernetes-sigs/"
                "metrics-server/releases/latest/download/components.yaml\n"
                "and on kind, let it accept the kubelet's self-signed certificate:\n"
                "  kubectl -n kube-system patch deploy metrics-server --type=json "
                "-p '[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0"
                "/args/-\",\"value\":\"--kubelet-insecure-tls\"}]'")
        raise NotReadyError("could not read pod metrics: " + ask.why(res))
    rows = []
    for line in (res.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 3:
            rows.append({"pod": parts[0],
                         "cpu_millicores": _parse_quantity(parts[1]),
                         "mem_bytes": _parse_quantity(parts[2])})
    return rows

def _pod_row(item: dict) -> dict:
    """Render one Kubernetes pod in the container-panel shape."""
    meta = item.get("metadata") or {}
    st = item.get("status") or {}
    # initContainerStatuses too: the MongoDB fix-permission and init containers
    # are exactly where a Kubernetes workspace gets stuck, and a pod whose init
    # container is in CrashLoopBackOff reports phase Pending and an EMPTY
    # containerStatuses -- so reading only the main list showed "0/0 ready" and
    # named nothing.
    cs = list(st.get("initContainerStatuses") or []) + list(st.get("containerStatuses") or [])
    main = list(st.get("containerStatuses") or [])
    ready = sum(1 for c in main if c.get("ready"))
    restarts = sum(int(c.get("restartCount") or 0) for c in cs)
    reason = ""
    for container in cs:
        state = container.get("state") or {}
        waiting = state.get("waiting") or {}
        terminated = state.get("terminated") or {}
        # A terminated init container that SUCCEEDED is not a reason -- that is
        # the normal end of an init container, and reporting "Completed" as the
        # pod's status hid a Rocket.Chat container that was crash-looping behind it.
        if terminated.get("reason") == "Completed":
            continue
        reason = str(waiting.get("reason") or terminated.get("reason") or "")
        if reason:
            break
    phase = str(st.get("phase") or "")
    status = reason or f"{ready}/{len(main)} ready"
    if restarts:
        status += f" · {restarts} restart" + ("s" if restarts != 1 else "")
    return {"service": str(meta.get("name") or ""),
            "state": phase.lower(), "status": status,
            "health": "healthy" if main and ready == len(main) else "",
            # WHICH POD IS ROCKET.CHAT ITSELF, decided by the label the
            # APP_SELECTOR above already names -- not by a substring of the
            # pod name, which is a naming rule the browser would then hold a
            # second copy of. The panel needs it to report Rocket.Chat's own
            # restart count on a runtime where nine pods have one each.
            "app": (meta.get("labels") or {}).get(
                "app.kubernetes.io/name") == "rocketchat",
            # Decided HERE, next to the list that defines it, because the
            # browser needs the answer and must not keep a second copy of
            # the policy: `ContainerCreating` and `PodInitializing` are
            # waiting reasons too, and a panel that treated every reason as
            # a failure would report a booting workspace as broken. The
            # create path spends the same list -- see terminal_pod_failure.
            "blocked": reason in TERMINAL_POD_REASONS,
            "restarts": restarts,
            "started": str(st.get("startTime") or "")}


def pod_rows(name: str, *, context: str) -> list[dict]:
    """Every pod in this workspace's namespace, in the shape the panel's containers
    tab already renders: [{service, state, status, health, restarts, started}].

    A pod is not a container, but the question is the one Compose's list answers --
    what is running, and is any of it unhappy -- so the tab renders the same three
    columns rather than growing a second Kubernetes-only view. ALL pods, not just
    Rocket.Chat's: the Compose tab lists Mongo and every sidecar too, and the pod
    that is wrong is usually not the one you went looking for.

    A waiting REASON outranks the phase in the status column. "Pending" says only
    that something has not happened; `ImagePullBackOff`, `CrashLoopBackOff` and
    `CreateContainerConfigError` say what, and that is the answer to "why is this
    workspace not up" -- which the GUI previously had no way to show at all, because
    this block was empty and the tab said "No containers -- this repro is down."
    under a workspace that was running.
    """
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "get", "pods", "-o", "json"], own=vocab.is_ours(context))
    if res.returncode != 0:
        # An unreachable cluster is the panel's "docker is unavailable": an empty
        # list, never a raise. detail() is on the path of every panel open, and a
        # workspace whose cluster is asleep still has to render.
        return []
    try:
        doc = json.loads(res.stdout or "{}")
    except ValueError:
        return []
    rows = []
    for item in doc.get("items") or []:
        rows.append(_pod_row(item))
    # Named order, so the tab does not reshuffle itself between two panel opens.
    rows.sort(key=lambda r: r["service"])
    return rows

#: Waiting-state reasons a pod will never recover from on its own. Taken from PR #3,
#: whose note is the important part: `ImagePullBackOff` alone is NOT terminal -- a slow
#: or rate-limited registry looks identical while it is still making progress -- so it
#: is the REASON that discriminates, not the phase.
TERMINAL_POD_REASONS = (
    "ErrImagePull", "ImagePullBackOff", "InvalidImageName",
    "CreateContainerConfigError", "CreateContainerError", "RunContainerError",
)

def terminal_pod_failure(name: str, *, context: str) -> tuple[str, str, str] | None:
    """The first pod condition that cannot succeed, as (pod, reason, message).

    Without this, a create waits out its whole timeout on something already decided:
    a mistyped version, an image the registry does not have, an unreachable registry.
    Ten minutes of "waiting for Rocket.Chat" for an answer Kubernetes had in seconds,
    and the eventual failure names the timeout rather than the cause.

    Returns None when nothing is terminal, so the caller keeps waiting -- the default
    has to be patience, or a slow pull becomes a failed create.
    """
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "get", "pods", "-o", "json"], own=vocab.is_ours(context))
    if res.returncode != 0:
        return None
    try:
        items = json.loads(res.stdout or "{}").get("items") or []
    except ValueError:
        return None
    for item in items:
        pod = item.get("metadata", {}).get("name", "")
        for status in (item.get("status", {}).get("containerStatuses") or []) + \
                      (item.get("status", {}).get("initContainerStatuses") or []):
            waiting = (status.get("state") or {}).get("waiting") or {}
            reason = str(waiting.get("reason") or "")
            if reason in TERMINAL_POD_REASONS:
                return pod, reason, str(waiting.get("message") or "").strip()
    return None

def workload_exists(name: str, *, context: str) -> bool:
    """Whether the Rocket.Chat deployment is present in the workspace's namespace.

    Distinct from the namespace existing, which survives a plain `down` along with
    the PVC. Without this a torn-down workspace reported "starting" indefinitely,
    because the only thing being asked was whether the namespace was there.

    RAISES rather than answering False when the cluster could not be asked. This
    returned `rc == 0 and stdout`, so a wrong context, an RBAC denial or a timeout
    all read as "the workload is not there" -- and `prunable()` then listed a LIVE
    workspace under "these down repros will be deleted, containers, data volumes and
    records". Measured: `prunable()` returned a workspace that was serving 200 at
    the time. The Docker branch of the same function already refuses to guess here.
    """
    answer = ask.ask_object("deployment", f"{RELEASE}-rocketchat",
                        namespace=kubens.namespace_for(name), context=context)
    if answer.refused:
        raise DockerError(
            f"could not ask cluster {context!r} whether {name!r} is running: "
            + (answer.why() or "the API server did not answer"))
    return answer.present
