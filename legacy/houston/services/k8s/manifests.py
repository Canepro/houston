"""The YAML houston authors, as documents rather than as strings.

Tier k3. Every manifest this package applies is built here, so what goes into a cluster can
be read in one place -- and so a test can assert on the document instead of grepping the
command line that carried it.
"""
from __future__ import annotations

from houston import config
from houston import runner
from houston import versions


from houston.services.k8s import names as vocab
from houston.services.k8s import namespace as kubens
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, CHART, MONGO_DIRECT_URI, MONGO_SERVICE, MONGO_VOLUME_GB

def container_security_context(chart_version: str) -> dict:
    """Drop `fsGroup` from the chart's CONTAINER securityContext, if it puts one there.

    `fsGroup` is a POD-level field. Chart 6.26.0 -- the exact-match chart for
    Rocket.Chat 7.10.0 -- ships `containerSecurityContext: {{runAsUser: 999,
    fsGroup: 999}}` and renders it onto the container, where the field does not
    exist. Helm 3 applied client-side and silently dropped it; Helm 4 applies
    server-side, and the API server refuses the whole Deployment:

        Error: server-side apply failed ... Kind=Deployment: failed to create typed
        patch object: .spec.template.spec.containers[name="rocketchat"]
        .securityContext.fsGroup: field not declared in schema

    That makes every Rocket.Chat 7.x install fail on this runtime, which went unseen
    because every live run so far used 8.5.1: chart 7.0.0 fixed it upstream.

    `null` rather than a replacement map, because Helm MERGES values: passing
    `{{runAsUser: 999}}` leaves the chart's `fsGroup: 999` in place underneath, and
    the render is unchanged. `null` is Helm's delete.

    And it is applied only where the chart actually has the field, which is why this
    reads the chart's own values first. Injecting `fsGroup: null` unconditionally put
    a literal `fsGroup: null` onto chart 7.0.0's container -- the same undeclared
    field, arrived at from the other direction. The UIDs differ too (999 in 6.26.0,
    65533 in 7.0.0), so nothing about this map is safe to write down here.
    """
    res = kube.run(["helm", "show", "values", CHART, "--version", chart_version],
              timeout=APPLY_TIMEOUT, own=True)
    if res.returncode != 0:
        return {}
    import yaml
    try:
        values = yaml.safe_load(res.stdout or "") or {}
    except yaml.YAMLError:
        return {}
    current = values.get("containerSecurityContext")
    if not isinstance(current, dict) or "fsGroup" not in current:
        return {}
    return {"containerSecurityContext": {"fsGroup": None}}


def _mongo_service_and_statefulset_head(label_yaml: str) -> str:
    """The headless Service and the metadata preceding the pod template."""
    return f"""apiVersion: v1
kind: Service
metadata:
  name: {MONGO_SERVICE}
  labels:
{label_yaml}
spec:
  clusterIP: None
  # The same circular dependency as the readiness probe, one layer down. A headless
  # Service does NOT publish DNS for a not-ready pod, and this pod cannot be ready
  # until the replica set is initiated -- so `rs.initiate` could not resolve
  # `{MONGO_SERVICE}-0.{MONGO_SERVICE}` to check the member is itself, and mongod
  # refused with "no host described in new configuration ... maps to this node".
  # Publishing not-ready addresses is the standard bootstrap pattern for a
  # StatefulSet database; the MongoDB operator does the same.
  publishNotReadyAddresses: true
  selector:
    app: {MONGO_SERVICE}
  ports:
  - port: 27017
    name: mongo
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {MONGO_SERVICE}
  labels:
{label_yaml}
spec:
  serviceName: {MONGO_SERVICE}
  replicas: 1
  selector:
    matchLabels:
      app: {MONGO_SERVICE}
"""


def _mongo_pod_template(tag: str, pod_labels: str) -> str:
    """The secured mongod container and its replica-set readiness probe."""
    return f"""  template:
    metadata:
      labels:
        app: {MONGO_SERVICE}
{pod_labels}
    spec:
      # PodSecurity `restricted` REJECTS A POD WITHOUT THIS, and it rejects it in the
      # quietest possible way: the StatefulSet is accepted, no pod is ever created,
      # and every diagnostic houston has goes blind -- `terminal_pod_failure` finds
      # no pod, `pod_rows` is empty, `storage_blocker` says nothing, and the PVC sits
      # Pending pointing at storage, which is not the problem. The user paid a 300s
      # wait and got an error naming `kubectl describe pod mongodb-0`, a pod that
      # does not exist. Mirrors what the operator path already sets.
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: mongod
        image: {vocab.mongo_image(tag)}
        args: ["--replSet", "rs0", "--bind_ip_all"]
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        # Requests so the scheduler can place it and a namespace quota does not
        # reject the pod outright; no CPU limit, because throttling mongod during a
        # restore is how a backup test becomes a timeout.
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            memory: 2Gi
        ports:
        - containerPort: 27017
        volumeMounts:
        - name: data
          mountPath: /data/db
        readinessProbe:
          exec:
            command: ["mongosh", "{MONGO_DIRECT_URI}", "--quiet", "--eval",
                      "db.adminCommand('ping')"]
          initialDelaySeconds: 10
          periodSeconds: 5
"""


def mongo_manifest(name: str, tag: str, *, owner: str = "",
                   storage_class: str = "") -> str:
    """A single-node MongoDB replica set with a PVC.

    A replica set rather than a standalone mongod because Rocket.Chat needs change
    streams. `volumeClaimTemplates` rather than nothing, so the data survives a
    pod reschedule -- see MONGO_VOLUME_GB.

    `storageClassName` is omitted when empty, which makes Kubernetes use the
    cluster's default. That is what keeps this working unchanged on kind
    (`standard`), k3s (`local-path`) and a real cluster.

    THE TAG IS RE-CHECKED HERE, not only where `--mongo` is accepted. This function
    builds YAML by f-string, so the tag is the one caller-supplied value that can
    add structure rather than fill a slot; `versions.apply_mongo_override` refuses
    a bad one at the boundary, and this is the guard for any other caller that
    reaches the template directly. Two checks rather than one because the boundary
    is the useful error and the template is the one that must not be wrong.
    """
    versions.require_valid_mongo_tag(tag)
    labels = kubens._labels(name, owner)

    def at(indent: int) -> str:
        """Label block at a given indent. Every nesting level needs its own: the
        first version reused one 4-space block everywhere, and inside
        `volumeClaimTemplates` that put the labels at the same level as `metadata`,
        so they became keys of the template item. The result is valid YAML and an
        invalid manifest -- which a `yaml.safe_load` test cannot see, and the API
        server rejected with "unknown field
        spec.volumeClaimTemplates[0].app.kubernetes.io/managed-by".
        """
        pad = " " * indent
        return "\n".join(f"{pad}{k}: {vocab.scalar(v)}" for k, v in labels.items())

    label_yaml = at(4)
    pod_labels = at(8)
    pvc_labels = at(8)
    # SIX SPACES, which is `accessModes`' own indent -- this was eight, so
    # `storageClassName` became a child of the scalar above it and the whole
    # two-document manifest stopped parsing. See the spec file.
    sc_line = f"\n      storageClassName: {storage_class}" if storage_class else ""
    return (_mongo_service_and_statefulset_head(label_yaml)
            + _mongo_pod_template(tag, pod_labels)
            + f"""  volumeClaimTemplates:
  - metadata:
      name: data
      labels:
{pvc_labels}
    spec:
      accessModes: ["ReadWriteOnce"]{sc_line}
      resources:
        requests:
          storage: {MONGO_VOLUME_GB}Gi
""")

def split_image(rc_image: str, rc_version: str) -> tuple[str, str]:
    """(repository, tag) for the chart, which wants them separately.

    `versions.resolve()` returns the REPOSITORY only -- compose composes it as
    f"{rc_image}:{rc_tag}" -- so a naive rpartition(":") on a tagless string
    returns the whole repository as the tag. That is truthy, so an `or rc_version`
    fallback does not save it, and the chart fed it to `semverCompare`, which
    failed the install with "invalid semantic version" rather than anything naming
    the image.

    A colon only introduces a tag when nothing after it looks like a path segment:
    `registry:5000/org/img` is a host with a port, not a tag. `--rc-image` lets a
    user pass either shape, so both are handled.
    """
    head, sep, tail = rc_image.rpartition(":")
    if sep and "/" not in tail:
        return head, tail
    return rc_image, rc_version

def render_scenario_manifest(manifest: str, name: str) -> str:
    """Bind a scenario's native resources to this namespace-local workspace.

    PR #3's substitution, kept verbatim: a scenario adapter cannot know the
    workspace name when it renders, so it writes a placeholder and the lifecycle
    fills it in. The label it feeds -- `houston.io/repro` -- is what makes the
    resource show up under this workspace's ownership rather than floating in the
    namespace unattributed.
    """
    return manifest.replace("__HOUSTON_NAME__", name)

def record_rendered(name: str, *, values: dict, manifests: dict) -> list[str]:
    """Write what was sent to helm and kubectl into the workspace directory.

    A Compose workspace has a docker-compose.yml you can read; a Kubernetes one had
    nothing but repro.json, because values go to `helm --values -` and manifests to
    `kubectl apply -f -` on stdin. That is good for secrets and bad for answering
    "what did it actually deploy" -- especially once the cluster is gone, when the
    live `helm get values` is no longer there to ask.

    So they are written for READING. Re-running `up` regenerates them, exactly as it
    regenerates docker-compose.yml, and editing them changes nothing -- the same
    contract the Compose file already has.

    SECRETS ARE NOT WRITTEN. The MongoDB URL carries a generated SCRAM password and
    lives only in a Kubernetes Secret; putting it here would undo the whole point of
    moving it off `helm get values`. `values.yaml` names the Secret instead, which is
    what the running release does too.
    """
    import yaml as _yaml
    ws = config.repros_dir() / name
    out = ws / "kubernetes"
    out.mkdir(parents=True, exist_ok=True)
    written = [str(out / "values.yaml")]
    runner.atomic_write(out / "values.yaml",
                        _yaml.safe_dump(values, sort_keys=False))
    for label, manifest in manifests.items():
        if not manifest:
            continue
        path = out / f"{label}.yaml"
        runner.atomic_write(path, manifest)
        written.append(str(path))
    return written
