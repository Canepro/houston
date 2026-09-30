"""Initialising the MongoDB replica set, which a StatefulSet cannot do for itself.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.services.events import Emit
from houston.services.events import info
from houston.services.events import null_emit
import time

from houston.services.k8s import ask
from houston.services.k8s import names as vocab
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, MONGO_DIRECT_URI, MONGO_SERVICE, tuning

#: Rocket.Chat needs change streams, which need a replica set. `--replSet rs0`
#: only puts mongod IN replica-set mode; without `rs.initiate()` there is no
#: primary, so nothing can write and Rocket.Chat waits forever. Compose has a
#: `mongo-init` service for exactly this; the first cut of this module had no
#: equivalent, and a real workspace sat at 5 pods for 540s with Rocket.Chat never
#: becoming ready and nothing in its logs naming MongoDB.
RS_INITIATE = ('rs.initiate({_id:"rs0",members:[{_id:0,'
               f'host:"{MONGO_SERVICE}-0.{MONGO_SERVICE}:27017"}}]}})')

MONGO_READY_INTERVAL = 5.0

#: The transient shapes of "the pod is not ready for this yet", which are worth
#: retrying because they resolve on their own within seconds.
#:
#: The second one is a defect found by running this on cold clusters. `init_replica_set`
#: waits for `containerStatuses[0].started` and says exactly why it cannot wait for
#: READINESS -- readiness needs the replica set, and this is the initiation. That
#: reasoning is right, and it leaves a window: the container is up and mongod has not
#: yet bound :27017. The exec then fails with
#:
#:     MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017
#:
#: and the retry predicate was an allow-list of ONE error, so a connection refusal
#: returned on the first attempt and failed the whole create. Reproduced twice out of
#: two on a freshly installed k3s -- an empty containerd store and a cold PVC make
#: mongod slow enough to lose the race every time, and both retries succeeded. So it
#: fired precisely on somebody's first create, which is the worst place for it.
_MONGO_TRANSIENT = (
    # `kubectl exec` into a container that exists but is not exec-able yet, or is on
    # its way out: a pod reports `started` while TERMINATING.
    "container not found",
    # mongod has not bound its socket yet. Both spellings appear, and the driver
    # lower-cases neither for us.
    "econnrefused",
    "connection refused",
)

def _mongo_exec(context: str, namespace: str, script: str, *, tries: int = 5,
               sleep=time.sleep):
    """mongosh inside the MongoDB pod, retried while the failure is a transient one.

    Retrying is safe for everything this is asked to run: `rs.initiate` is guarded by
    its caller's "already initialized" check, and `rs.status().ok` is a read.
    """
    for attempt in range(tries):
        res = _mongo_exec_once(context, namespace, script)
        combined = f"{res.stdout or ''}{res.stderr or ''}".lower()
        if res.returncode == 0 or not any(t in combined for t in _MONGO_TRANSIENT):
            return res
        sleep(2.0)
    return res

def _mongo_exec_once(context: str, namespace: str, script: str):
    return kube.run(["kubectl", "--context", context, "-n", namespace, "exec",
                f"{MONGO_SERVICE}-0", "--", "mongosh", MONGO_DIRECT_URI,
                "--quiet", "--eval", script],
               timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))


def _wait_for_primary(context: str, namespace: str, *, tries: int = 6,
                      sleep=time.sleep) -> bool:
    """Wait until a restarted single-node set can accept writes again."""
    for _ in range(tries):
        res = _mongo_exec(context, namespace, "db.hello().isWritablePrimary")
        if (res.stdout or "").strip().lower() == "true":
            return True
        sleep(2.0)
    return False


def _finish_replica_set(context: str, namespace: str, combined: str,
                        emit: Emit, sleep) -> None:
    """Verify a primary, repairing a persisted REMOVED member after restart."""
    if _wait_for_primary(context, namespace, sleep=sleep):
        info(emit, "replica set ready", phase="boot")
        return
    if "already initialized" in combined:
        repaired = _mongo_exec(context, namespace,
                               "rs.reconfig(rs.conf(), {force:true})")
        if repaired.returncode == 0 and _wait_for_primary(context, namespace, sleep=sleep):
            info(emit, "replica set recovered after restart", phase="boot")
            return
    ok = _mongo_exec(context, namespace, "rs.status().ok")
    if (ok.stdout or "").strip() != "1":
        raise CreateFailedError(
            "the MongoDB replica set is not initiated, so Rocket.Chat's change "
            "streams cannot work: " + ask.why(ok))
    info(emit, "replica set ready", phase="boot")


def init_replica_set(*, namespace: str, context: str, emit: Emit = null_emit,
                     sleep=time.sleep) -> None:
    """Wait for MongoDB, initiate the single-node replica set, and VERIFY it.

    Structure taken from PR #3, whose docstring records the failure this shape
    exists to avoid: `kubectl wait` called the instant after `apply`, before the
    pod existed, so it failed immediately and `rs.initiate` then ran against
    nothing -- with both errors discarded and the repro reported as created.

    So: poll for the pod, initiate, tolerate an already-initiated set, and check
    `rs.status().ok` rather than trusting an exit code. A failure here is
    CreateFailedError -- exit 7, known dead -- because every second spent waiting
    afterwards is spent waiting for something that cannot happen.
    """
    # RUNNING, not READY -- and the difference is a circular wait. The readiness
    # probe cannot pass until the replica set is initiated, and initiation cannot
    # run until something answers. Waiting on readiness here made the whole create
    # a coin flip: the probe occasionally scraped through and the workspace built,
    # otherwise it timed out at 300s reporting that MongoDB never became ready --
    # while mongod had in fact been up the whole time, logging
    # "ReadConcernMajorityNotAvailableYet".
    for attempt in range(tuning.MONGO_READY_TRIES):
        # `started`, not `phase`. A pod reports Running before its container is
        # exec-able, and `kubectl exec` then fails with `container not found
        # ("mongod")` -- which is what `up` after a plain `down` hit: the PVC was
        # still there, the StatefulSet came back, the pod said Running, and the exec
        # raced the container.
        #
        # Not `ready` either: readiness needs the replica set initiated, and this IS
        # the initiation. `started` is the field that means "the container is up",
        # independent of whether it is serving.
        res = kube.run(["kubectl", "--context", context, "-n", namespace, "get", "pod",
                   f"{MONGO_SERVICE}-0", "-o",
                   "jsonpath={.status.containerStatuses[0].started}"],
                  own=vocab.is_ours(context))
        if (res.stdout or "").strip() == "true":
            break
        if attempt % 6 == 0:
            info(emit, "waiting for MongoDB", phase="wait")
        sleep(MONGO_READY_INTERVAL)
    else:
        raise CreateFailedError(
            "the MongoDB pod never started, and Rocket.Chat cannot work without it "
            f"(kubectl -n {namespace} describe pod {MONGO_SERVICE}-0)")

    info(emit, "initiating the replica set", phase="boot", pct=45)
    res = _mongo_exec(context, namespace, RS_INITIATE)
    combined = f"{res.stdout or ''}{res.stderr or ''}".lower()
    if res.returncode != 0 and "already initialized" not in combined:
        raise CreateFailedError("could not initiate the MongoDB replica set: "
                                + combined.strip()[:300])
    # A cold restart can resolve the member hostname too late. MongoDB then keeps
    # the persisted member in REMOVED and never elects it again, even after DNS is
    # healthy. `_finish_replica_set` reapplies that one-member config with force.
    _finish_replica_set(context, namespace, combined, emit, sleep)
