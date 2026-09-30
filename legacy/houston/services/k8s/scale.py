"""Scaling a workspace down and back up, and remembering what it was.
"""
from __future__ import annotations

from houston.errors import DockerError, NotFoundError
from houston.services.events import Emit
from houston.services.events import info
import json
from houston.services.events import null_emit
import time
from houston.services.events import warn

from houston.services.k8s import ask
from houston.services.k8s import names as vocab
from houston.services.k8s import namespace as kubens
from houston.services.k8s import replicaset
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, MONGO_SERVICE, RELEASE

#: Where the replica count lives while a workspace is stopped. Kubernetes has no
#: "stopped" state -- scaling to 0 is the whole mechanism -- so the number that was
#: there has to be written down or `start` cannot put it back. An annotation on the
#: namespace rather than repro.json, because `kubectl scale` by hand is a legitimate
#: thing for someone to do and the cluster should carry its own truth.
SCALE_ANNOTATION = "houston.io/replicas-before-stop"

def _scalables(namespace: str, context: str) -> list[str]:
    """Every workload in the namespace that has a replica count, as `kind/name`.

    The MongoDB StatefulSet is included deliberately. `docker compose stop` stops the
    database too, and a workspace that keeps 8Gi of MongoDB resident while claiming
    to be stopped is not stopped in the sense anyone means -- the whole reason to
    stop one on a laptop is to get the memory back.
    """
    res = kube.run(["kubectl", "--context", context, "-n", namespace, "get",
               "deployment,statefulset", "-o", "name"], own=vocab.is_ours(context))
    return [ln.strip() for ln in (res.stdout or "").splitlines() if ln.strip()]

def scale_workspace(name: str, *, replicas: int, context: str,
                    emit: Emit = null_emit) -> int:
    """Scale every workload in a workspace to `replicas`. Returns how many it moved.

    `--all` is not used: it would also catch anything a preset or a person added,
    and scaling something back up to a number it never had is worse than leaving it.
    """
    namespace = kubens.namespace_for(name)
    targets = _scalables(namespace, context)
    if not targets:
        raise NotFoundError(
            f"{name!r} has no workloads to scale -- it was `down`ed, so there is "
            f"nothing to stop or start. Recreate it with `houston up --name {name}`")
    res = kube.run(["kubectl", "--context", context, "-n", namespace, "scale",
               f"--replicas={replicas}", *targets],
              timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        raise DockerError(f"could not scale {name!r}: " + ask.why(res))
    return len(targets)

def desired_replicas(name: str, *, context: str) -> int:
    """The Rocket.Chat Deployment's DESIRED replica count, or -1 if unknown.

    `.spec.replicas`, not `.status`: the question is what was asked for, so that a
    workspace scaled to zero reads as stopped the instant `stop` returns rather than
    once the pods have finished terminating.
    """
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name), "get",
               "deployment", f"{RELEASE}-rocketchat", "-o",
               "jsonpath={.spec.replicas}"], own=vocab.is_ours(context))
    try:
        return int((res.stdout or "").strip())
    except ValueError:
        return -1

#: Up to a minute for pods to terminate. MongoDB gets a grace period and uses it.
POD_GONE_TRIES = 30

POD_GONE_INTERVAL = 2.0

def stop_workspace(name: str, *, context: str, emit: Emit = null_emit,
                   sleep=time.sleep) -> int:
    """Scale to zero, remembering what to come back to, and wait for it."""
    namespace = kubens.namespace_for(name)
    # Recorded BEFORE scaling, or the number read back is the zero we just wrote.
    before = {}
    for target in _scalables(namespace, context):
        res = kube.run(["kubectl", "--context", context, "-n", namespace, "get", target,
                   "-o", "jsonpath={.spec.replicas}"], own=vocab.is_ours(context))
        count = (res.stdout or "").strip()
        if count and count != "0":
            before[target] = count
    if before:
        kube.run(["kubectl", "--context", context, "-n", namespace, "annotate",
             "--overwrite", "namespace", namespace,
             f"{SCALE_ANNOTATION}={json.dumps(before)}"], own=vocab.is_ours(context))
    moved = scale_workspace(name, replicas=0, context=context, emit=emit)
    # An operator-managed MongoDB CANNOT be scaled to zero: the operator reconciles
    # its StatefulSet straight back, and the Community operator has no way to pause
    # reconciliation. So its pods are expected to survive `stop`, and two things
    # follow that an audit caught this doing wrong.
    #
    # First, the wait below must not require them to go, or every stop and restart on
    # the operator path burns POD_GONE_TRIES * POD_GONE_INTERVAL seconds waiting for
    # something that will never happen, then continues anyway.
    #
    # Second and worse, `stop` documents itself as giving the memory back. On this
    # path it gives back Rocket.Chat's and not MongoDB's, and said nothing -- so the
    # user who ran `stop` to free the box was told it had worked. Say it instead.
    survivors = mongo_pods_the_operator_keeps(name, context=context)
    if survivors:
        warn(emit, f"MongoDB stays up: it is operator-managed, and the operator "
                   f"recreates it as fast as it is scaled down (there is no way to "
                   f"pause its reconciliation). Rocket.Chat's memory is freed, "
                   f"MongoDB's is not — `houston down --name {name} --volumes` is "
                   f"what reclaims it.", phase="done")
    # WAIT for the pods to actually go, rather than returning on the API call.
    # `restart` is stop-then-start, so returning early scales back up while the old
    # pods are still Terminating -- and the readiness check then finds one of THOSE,
    # reports ready, and the port-forward attaches to a pod on its way out. The URL
    # answers nothing. This is the fourth time on this runtime that trusting a
    # readiness signal over the actual state has produced a workspace that looks up
    # and is not.
    for _ in range(POD_GONE_TRIES):
        res = kube.run(["kubectl", "--context", context, "-n", namespace, "get", "pods",
                   "-o", "name"], own=vocab.is_ours(context))
        left = [p for p in (res.stdout or "").split() if p.strip()]
        if not [p for p in left if p not in survivors]:
            break
        sleep(POD_GONE_INTERVAL)
    info(emit, f"scaled {moved} workload(s) to zero", phase="done")
    return moved

def mongo_pods_the_operator_keeps(name: str, *, context: str) -> set[str]:
    """Pod names (as `pod/<n>`) that an operator-managed MongoDB will not give up.

    Empty for the hand-written StatefulSet, which scales to zero like anything else.
    """
    namespace = kubens.namespace_for(name)
    res = kube.run(["kubectl", "--context", context, "-n", namespace,
               "get", "mongodbcommunity", "-o", "name"], own=vocab.is_ours(context))
    if res.returncode != 0 or not (res.stdout or "").strip():
        return set()
    pods = kube.run(["kubectl", "--context", context, "-n", namespace, "get", "pods",
                "-l", f"app={MONGO_SERVICE}-svc", "-o", "name"],
               own=vocab.is_ours(context))
    return {p for p in (pods.stdout or "").split() if p.strip()}

def start_workspace(name: str, *, context: str, emit: Emit = null_emit) -> int:
    """Scale back to whatever was recorded, or to 1 if nothing was.

    A workspace stopped by hand (`kubectl scale ... --replicas=0`) carries no
    annotation, and refusing to start it would be pedantry -- 1 is what `up` would
    have given it.
    """
    namespace = kubens.namespace_for(name)
    # Read as JSON and pick the key in Python, rather than through jsonpath.
    #
    # jsonpath was how this went wrong: the key is `houston.io/replicas-before-stop`
    # and the code escaped the SLASH while leaving the DOT in `houston.io`
    # unescaped -- so jsonpath read `houston` and `io/...` as separate path segments,
    # matched nothing, and returned empty. Measured against a live cluster: the
    # slash-escaped form returns "" while the dot-escaped form returns the
    # annotation. Every stop/start therefore restored the DEFAULT of 1, silently
    # turning a `--replicas 2` workspace into a one-replica one, and the annotation
    # written to prevent exactly that was never once read back.
    #
    # No escaping at all is a rule that cannot be got subtly wrong.
    res = kube.run(["kubectl", "--context", context, "-n", namespace, "get", "namespace",
               namespace, "-o", "json"], own=vocab.is_ours(context))
    before = {}
    try:
        annotations = (json.loads(res.stdout or "{}").get("metadata", {})
                       .get("annotations") or {})
        before = json.loads(annotations.get(SCALE_ANNOTATION) or "{}")
    except ValueError:
        before = {}
    if not isinstance(before, dict):
        before = {}
    targets = _scalables(namespace, context)
    if not targets:
        raise NotFoundError(
            f"{name!r} has no workloads to start -- it was `down`ed. Recreate it "
            f"with `houston up --name {name}`")
    mongo = [target for target in targets if target.rsplit("/", 1)[-1] == MONGO_SERVICE]
    rest = [target for target in targets if target not in mongo]
    for target in mongo + rest:
        count = str(before.get(target, "1"))
        res = kube.run(["kubectl", "--context", context, "-n", namespace, "scale",
                   f"--replicas={count}", target],
                  timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
        if res.returncode != 0:
            raise DockerError(f"could not scale {target}: " + ask.why(res))
        if target in mongo and not mongo_pods_the_operator_keeps(name, context=context):
            replicaset.init_replica_set(namespace=namespace, context=context, emit=emit)
    info(emit, f"scaled {len(targets)} workload(s) back up", phase="done")
    return len(targets)

def scale_rocketchat(name: str, *, replicas: int, context: str) -> int:
    """Scale ONLY Rocket.Chat, leaving MongoDB up.

    What `stop_workspace` does is wrong for a backup: a dump needs the database
    running and only its writers quiesced. This is the Kubernetes counterpart of
    runner.stop_services, and the same distinction runner draws between `stop()` and
    `stop_services()`.
    """
    namespace = kubens.namespace_for(name)
    targets = [ln.strip() for ln in
               (kube.run(["kubectl", "--context", context, "-n", namespace, "get",
                     "deployment", "-l", "app.kubernetes.io/name=rocketchat",
                     "-o", "name"], own=vocab.is_ours(context)).stdout or "").splitlines()
               if ln.strip()]
    if not targets:
        return 0
    res = kube.run(["kubectl", "--context", context, "-n", namespace, "scale",
               f"--replicas={replicas}", *targets],
              timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    return res.returncode
