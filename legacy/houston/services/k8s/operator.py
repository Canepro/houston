"""The MongoDB Community operator: installing it, owning it, and knowing when it is
somebody else's.

Shared across every workspace on the cluster, so nothing here removes it without
checking who else is using it -- and a list that could not be read is never proof that
nobody is.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston.services.events import Emit
from houston.errors import PreflightError
import base64
from houston import config
from houston.services.events import info
from houston.services.events import null_emit
import time
from houston.services.events import warn

from houston.services.k8s import ask
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import namespace as kubens
from houston.services.k8s import release as kuberelease
from houston.services.k8s.ask import Answer, REFUSED
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, INSTALL_TIMEOUT, MONGO_SERVICE, MONGO_VOLUME_GB, NAMESPACE_PREFIX, tuning
from houston.services.k8s.replicaset import MONGO_READY_INTERVAL

#: The operator lives ONCE per cluster, in houston's own namespace, watching all
#: namespaces. The official guide installs it into the workspace namespace because
#: it assumes one Rocket.Chat per cluster; its CRDs are cluster-scoped, so a second
#: per-namespace install collides on them rather than giving you a second operator.
OPERATOR_NAMESPACE = "houston-system"

OPERATOR_RELEASE = "mongodb-kubernetes-operator"

OPERATOR_REPO = "mongodb"

OPERATOR_REPO_URL = "https://mongodb.github.io/helm-charts"

OPERATOR_CHART = f"{OPERATOR_REPO}/mongodb-kubernetes"

#: The oldest MongoDB the operator will manage. Below this houston falls back to
#: the hand-written StatefulSet, which is why that code stays: houston pairs twelve
#: MongoDB versions (3.0 through 8.2) because "the customer's exact version" is the
#: product's promise, and the operator's window does not reach the old half.
#:
#: 6.0 was a guess, and this is what came of checking it rather than leaving the
#: guess in place:
#:
#:   - The operator's own documentation states NO minimum server version. Its
#:     supported-features list covers replica sets, SCRAM, TLS and scaling with no
#:     version window attached, so there is nothing there to copy.
#:   - Its image repository, quay.io/mongodb/mongodb-community-server, publishes
#:     tags back to 4.4 -- so the pullable floor is 4.4, not 6.0.
#:   - 6.0 is verified live, via the operator, end to end.
#:
#: So 6.0 stays: deliberately conservative, now evidenced rather than invented.
#: Nothing houston supports goes near it -- Rocket.Chat 7.x and 8.x pair with
#: MongoDB 7.0, 8.0 and 8.2, and all three are verified live -- so the cost of being
#: conservative here is zero and the cost of being wrong the other way is a
#: workspace that never starts.
OPERATOR_MIN_MONGO = (6, 0)

#: SCRAM users, matching the guide's names so its commands transfer.
MONGO_ADMIN_USER = "admin"

MONGO_APP_USER = "rocketchat"

MONGO_APP_DB = "rocketchat"

#: The ServiceAccount the operator puts on the database pod. Not configurable and
#: not namespaced to the operator: the StatefulSet the operator writes into OUR
#: namespace names this account, so it has to exist THERE, not where the operator
#: runs. `kubectl -n <ns> get sts mongodb -o jsonpath='{.spec.template.spec.serviceAccountName}'`
#: is where the name comes from.
MONGO_DB_SERVICE_ACCOUNT = "mongodb-kubernetes-appdb"

#: The operator is OPT-IN until it is proven, and the reason is a regression I
#: caused. The hand-written StatefulSet was verified end to end on a live cluster --
#: admin login, PVC Bound, data surviving a down/up cycle. Routing MongoDB 6.0+ to
#: the operator by default replaced that with a path whose PVC never binds:
#:
#:     it reports: Pending ReplicaSet is not yet ready, retrying in 10 seconds
#:     data-volume-mongodb-0   Pending
#:
#: A default that breaks the working case is worse than a missing feature, so the
#: operator waits behind this flag until a live run says otherwise. Auth is the
#: thing it buys and auth is still absent without it -- that is the honest trade,
#: and it is recorded here rather than in a plan nobody reads.
USE_OPERATOR_ENV = "HOUSTON_MONGO_OPERATOR"

def operator_enabled() -> bool:
    """Whether to use the operator at all. Off by default -- see USE_OPERATOR_ENV."""
    return config.env(USE_OPERATOR_ENV).strip().lower() in ("1", "true", "yes")

def operator_supports(mongo_tag: str, *, forced: bool = False) -> bool:
    """Whether the operator will manage this MongoDB version.

    `forced` is `--mongo-operator`: the user asked for it explicitly, so the opt-in
    switch is satisfied and only the VERSION floor still applies. Asking for the
    operator on MongoDB 5.0 still falls back, because the operator cannot manage it
    -- silently ignoring the flag would be worse than the fallback.
    """
    if not forced and not operator_enabled():
        return False
    try:
        parts = tuple(int(n) for n in str(mongo_tag).split(".")[:2])
    except (ValueError, TypeError):
        return False
    return len(parts) == 2 and parts >= OPERATOR_MIN_MONGO

def _mongo_rbac_document(lab: str) -> str:
    """Render the namespaced service account, role and binding."""
    return f"""apiVersion: v1
kind: ServiceAccount
metadata:
  name: {MONGO_DB_SERVICE_ACCOUNT}
  labels:
{lab}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {MONGO_DB_SERVICE_ACCOUNT}
  labels:
{lab}
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["patch", "delete", "get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {MONGO_DB_SERVICE_ACCOUNT}
  labels:
{lab}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {MONGO_DB_SERVICE_ACCOUNT}
subjects:
- kind: ServiceAccount
  name: {MONGO_DB_SERVICE_ACCOUNT}
"""


def mongo_rbac_manifest(name: str, *, owner: str = "") -> str:
    """The database pod's ServiceAccount, Role and RoleBinding, in OUR namespace.

    The guide never mentions these because it installs the operator into the same
    namespace as MongoDB, where the operator's own chart creates them. houston
    cannot do that -- the chart owns cluster-scoped CRDs, so a per-workspace install
    collides on them at the second workspace -- so the operator lives once in
    `houston-system` and watches everything. That works for reconciliation and
    silently does not work for the database pod, which needs an account the chart
    only created next to itself.

    Missing, the failure names none of this. The StatefulSet appears, the claims
    appear, and then:

        Warning  FailedCreate  statefulset/mongodb  Create Pod mongodb-0 ... failed
        error: pods "mongodb-0" is forbidden: error looking up service account
        <ns>/mongodb-kubernetes-appdb: serviceaccount ... not found

    is an event on the StatefulSet, while the MongoDBCommunity resource -- the thing
    anyone would look at -- reports only "Pending ReplicaSet is not yet ready,
    retrying in 10 seconds", forever. No pod is ever created, so `WaitForFirstConsumer`
    keeps both PVCs Pending, which is the symptom that shows up first and points at
    storage, which is not the problem.

    The rules are copied from the Role the operator's chart creates for itself; they
    are what a member pod needs and nothing more -- read its own password Secret, and
    patch/delete/get its own Pod to mark readiness and roll itself. Everything here
    is namespaced, so `down` removing the namespace removes it.
    """
    labels = kubens._labels(name, owner)
    lab = "\n".join(f"    {k}: {vocab.scalar(v)}" for k, v in labels.items())
    return _mongo_rbac_document(lab)

def mongo_secret_manifest(name: str, *, admin_password: str, app_password: str,
                          owner: str = "") -> str:
    """The guide's five Secrets, with generated passwords rather than placeholders.

    `stringData` so Kubernetes does the base64; writing it ourselves is one more
    place to get wrong. The passwords never touch disk on this side -- the manifest
    goes to `kubectl apply` on stdin.
    """
    labels = kubens._labels(name, owner)
    lab = "\n".join(f"    {k}: {vocab.scalar(v)}" for k, v in labels.items())
    def secret(sname: str, data: dict) -> str:
        # A GENERATED password that happens to be all digits is an integer to a YAML
        # 1.1 reader, and `stringData` wants a string.
        body = "\n".join(f"  {k}: {vocab.scalar(v)}" for k, v in data.items())
        return (f"---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: {sname}\n"
                f"  labels:\n{lab}\ntype: Opaque\nstringData:\n{body}\n")
    return "".join([
        secret("mongodb-admin-password", {"password": admin_password}),
        secret("mongodb-rocketchat-password", {"password": app_password}),
        secret("admin-scram-credentials",
               {"username": MONGO_ADMIN_USER, "password": admin_password}),
        secret("rocketchat-scram-credentials",
               {"username": MONGO_APP_USER, "password": app_password}),
    ])

def operator_version(tag: str) -> str:
    """A full MongoDB release version for the operator's `spec.version`.

    houston carries a Docker TAG -- "8.0" -- because that is what pulls an image.
    The operator wants a RELEASE version and the guide shows "8.0.0"; given "8.0" it
    accepts the resource and then never reconciles it, so the workspace sits at no
    `.status.phase` until the wait gives up. The failure names nothing: the resource
    exists, the operator is healthy, and MongoDB simply never appears.

    A tag that already has three parts is passed through, so an explicit
    `--mongo 8.0.4` still means 8.0.4.
    """
    parts = str(tag).split(".")
    while len(parts) < 3:
        parts.append("0")
    return ".".join(parts[:3])

def _mongodb_volume_claims(storage_gb: int) -> str:
    """The data and logs claims required by the operator-managed pod."""
    return f"""      volumeClaimTemplates:
      - metadata:
          name: data-volume
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: {storage_gb}Gi
      # `logs-volume` as well as `data-volume`, because overriding
      # volumeClaimTemplates REPLACES the operator's list rather than merging with
      # it -- confirmed by watching a run that declared only data-volume produce
      # exactly one PVC -- while both of the pod's containers mount both volumes:
      #
      #   mongod:         data-volume ... logs-volume ...
      #   mongodb-agent:  data-volume ... logs-volume ...
      #
      # so a template list that drops one leaves the pod referencing a claim nothing
      # creates. The guide shows only data-volume because its example is the whole
      # override, and it is reproduced here in full for the same reason.
      - metadata:
          name: logs-volume
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 2Gi
"""


def mongodb_community_manifest(name: str, tag: str, *, owner: str = "",
                               storage_gb: int = MONGO_VOLUME_GB) -> str:
    """The guide's MongoDBCommunity resource.

    `type: ReplicaSet` with `members: 1` is what makes this worth doing: the
    operator owns initiation, readiness and the bootstrap DNS -- the three things
    that produced four separate live failures when this module did them by hand.
    """
    labels = kubens._labels(name, owner)
    lab = "\n".join(f"    {k}: {vocab.scalar(v)}" for k, v in labels.items())
    return f"""apiVersion: mongodbcommunity.mongodb.com/v1
kind: MongoDBCommunity
metadata:
  name: {MONGO_SERVICE}
  labels:
{lab}
spec:
  members: 1
  type: ReplicaSet
  version: "{operator_version(tag)}"
  security:
    authentication:
      modes: ["SCRAM"]
    tls:
      enabled: false
  users:
  - name: {MONGO_ADMIN_USER}
    db: admin
    passwordSecretRef:
      name: mongodb-admin-password
    scramCredentialsSecretName: admin-scram-credentials
    roles:
    - name: root
      db: admin
  - name: {MONGO_APP_USER}
    db: {MONGO_APP_DB}
    passwordSecretRef:
      name: mongodb-rocketchat-password
    scramCredentialsSecretName: rocketchat-scram-credentials
    roles:
    - name: readWrite
      db: {MONGO_APP_DB}
    # clusterMonitor is what makes MONGO_OPLOG_URL work, and it is what Rocket.Chat's
    # OWN chart grants: templates/mongodb-init-configmap.yaml runs
    #   db.getSiblingDB('<db>').grantRolesToUser('<user>',
    #       [{{ role: 'clusterMonitor', db: 'admin' }}])
    # against its bundled MongoDB, commenting "having clusterMonitor role shouldn't
    # hurt". readWrite on the app database alone cannot read `local`, so Rocket.Chat
    # below 8.x -- the only versions that still tail the oplog -- could authenticate
    # and then fail to tail. This is upstream's answer, not an invention.
    - name: clusterMonitor
      db: admin
  statefulSet:
    spec:
{_mongodb_volume_claims(storage_gb)}"""

#: The Secret the chart reads its MongoDB URL from, instead of the URL sitting in
#: the release's values where `helm get values rocketchat` prints it in full --
#: password included -- to anyone with read access to the namespace. The workspace
#: credentials are deliberately weak, but the operator's are generated per workspace
#: and are the thing SCRAM auth exists to protect.
MONGO_URL_SECRET = "rocketchat-mongodb-url"

#: The EE registration token travels in its own Opaque Secret, referenced from the
#: container env by `valueFrom`. NEVER in helm values or `extraEnv` as a literal:
#: values are readable with `helm get values` by anyone who can reach the release, and
#: houston also writes them to `repros/<n>/kubernetes/values.yaml` for a human to
#: read -- which is exactly the exposure the MongoDB password was moved out of. The
#: manifest goes to `kubectl apply -f -` on stdin so the token never appears in argv
#: either, where `ps` would show it to every user on the box.
REG_TOKEN_SECRET = "houston-reg-token"

REG_TOKEN_KEY = "token"

def reg_token_secret_manifest(name: str, *, token: str, owner: str = "") -> str:
    """An Opaque Secret holding the cloud registration token."""
    import yaml as _yaml
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": REG_TOKEN_SECRET, "labels": kubens._labels(name, owner)},
        "type": "Opaque",
        "stringData": {REG_TOKEN_KEY: token},
    }
    return _yaml.safe_dump(body, sort_keys=False)

def mongo_url_secret_manifest(name: str, *, mongo_url: str, oplog_url: str,
                              owner: str = "") -> str:
    """A Secret holding the connection strings, for `existingMongodbSecret`.

    BOTH keys, always. Chart 6.26.0 reads `mongo-uri` and `mongo-oplog-uri` from
    this Secret unconditionally once `existingMongodbSecret` is set -- there is no
    `if oplog` around the second one -- so omitting it on a chart that wants it
    leaves the pod unable to start on a missing key.
    """
    labels = kubens._labels(name, owner)
    lab = "\n".join(f"    {k}: {vocab.scalar(v)}" for k, v in labels.items())
    return f"""apiVersion: v1
kind: Secret
metadata:
  name: {MONGO_URL_SECRET}
  labels:
{lab}
type: Opaque
stringData:
  mongo-uri: {mongo_url}
  mongo-oplog-uri: {oplog_url}
"""

def mongo_tool_auth(name: str, *, context: str) -> list[str]:
    """`mongodump`/`mongorestore` flags for an operator-managed MongoDB.

    The operator enables SCRAM, so an unauthenticated `mongodump` fails with
    "Command listCollections requires authentication" -- which is exactly what it did:
    backup was broken on the operator path, the path the official guide recommends,
    while working perfectly on the hand-written StatefulSet that has no auth. The
    audit found it because it ran both.

    The password is read back out of the Secret rather than kept anywhere: it is
    generated at create time and deliberately never written to disk, which is a
    property worth keeping (`repros/<n>/kubernetes/` is checked for exactly this).

    Empty list when there is no operator, so the StatefulSet path is unchanged.
    """
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name),
               "get", "secret", "mongodb-rocketchat-password",
               "-o", "jsonpath={.data.password}"], own=vocab.is_ours(context))
    encoded = (res.stdout or "").strip()
    if res.returncode != 0 or not encoded:
        return []
    try:
        password = base64.b64decode(encoded).decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError):
        return []
    if not password:
        return []
    # authenticationDatabase is MONGO_APP_DB, not `admin`: the app user is DEFINED
    # in the application database, and authenticating against admin looks for a user
    # that was never created there. The same mistake, on authSource, is recorded in
    # operator_mongo_url's docstring.
    return ["--username", MONGO_APP_USER, "--password", password,
            "--authenticationDatabase", MONGO_APP_DB]

def operator_mongo_url(namespace: str, password: str, *, oplog: bool = False) -> str:
    """The authenticated URI, built as the guide builds it.

    The operator names its service `<name>-svc`, not `<name>` -- a detail worth
    stating, because the hand-written path uses the bare name and the two are not
    interchangeable.

    `authSource` is on BOTH forms, and the oplog one is where it was missing. The
    oplog URL addresses the `local` DATABASE, but the user is defined in
    `{MONGO_APP_DB}` -- and without authSource the driver authenticates against the
    database in the path, so it looked for a `{MONGO_APP_USER}` in `local` that has
    never existed there. Two faults in one line: even once authentication succeeded,
    reading `local` needs clusterMonitor, which the user now carries.

    Only Rocket.Chat below 8.x uses this at all; 8.x dropped oplog tailing. That is
    also why it survived so long unnoticed -- every live run of the operator path
    used 8.5.1, where the URL is never emitted.
    """
    db = "local" if oplog else MONGO_APP_DB
    return (f"mongodb://{MONGO_APP_USER}:{password}@"
            f"{MONGO_SERVICE}-0.{MONGO_SERVICE}-svc.{namespace}.svc.cluster.local:27017/"
            f"{db}?replicaSet={MONGO_SERVICE}&authSource={MONGO_APP_DB}")

#: The CRD that defines "MongoDBCommunity resources exist in this cluster". Presence
#: is keyed on this and NOT on houston's release name, for the reason
#: `cert_manager_installed` gives about its own CRD: "the release can be named
#: anything". An operator a platform team installed -- different namespace, different
#: release, or plain manifests -- is invisible to a question asked about our release.
MONGODB_CRD = "mongodbcommunity.mongodb.com"

#: The env var the community operator reads to decide what it reconciles. Empty means
#: its own namespace only; `*` means the whole cluster.
WATCH_ENV = "WATCH_NAMESPACE"

def operator_presence(context: str) -> Answer:
    """Whether a MongoDB Community operator's CRD is here, whoever installed it.

    THE ASYMMETRY THIS CLOSES: cert-manager is keyed on `certificates.cert-manager.io`
    and ingress on any existing IngressClass, and both therefore ADOPT a foreign
    install. The MongoDB operator was the one place that principle was not applied --
    it asked whether houston's own release existed in houston's own namespace, so a
    platform team's operator was invisible and `helm upgrade --install` ran anyway.

    On a shared cluster that means a second cluster-scoped controller with
    `watchNamespace=*` reconciling `MongoDBCommunity` resources belonging to workloads
    houston knows nothing about, and a chart-version difference reaching cluster-scoped
    CRDs another install owns.
    """
    return ask.ask_object("crd", MONGODB_CRD, context=context)

def operator_is_ours(seen: Answer) -> bool:
    """Whether the CRD in `seen` is managed by houston's own helm release.

    Helm stamps every resource it manages with `meta.helm.sh/release-name` and
    `meta.helm.sh/release-namespace`, so the CRD itself says who owns it -- which is
    the question that matters before running `upgrade --install` over it. A CRD with
    no such annotations was applied by something other than helm and is nobody's
    release; it is emphatically not ours.
    """
    meta = ((seen.doc or {}).get("metadata") or {})
    ann = (meta.get("annotations") or {})
    return (ann.get("meta.helm.sh/release-name") == OPERATOR_RELEASE
            and ann.get("meta.helm.sh/release-namespace") == OPERATOR_NAMESPACE)

def operator_watch_scope(context: str) -> tuple[str, str]:
    """(what the operator on this cluster watches, why that could not be read).

    An adopted operator is only useful if it reconciles the namespace the workspace
    goes in. The community operator takes that from `WATCH_NAMESPACE`: unset means its
    own namespace alone, `*` means the cluster.

    BEST EFFORT, and the caller must treat a reason as "I could not ask" rather than
    as "it does not watch us" -- the module's governing rule. Adopting is the action
    that installs nothing, so it is the safe thing to do when the scope is unknown;
    refusing on ignorance would break every cluster whose operator we simply could not
    introspect.
    """
    found = ask.ask_list("deployments", context=context, all_namespaces=True)
    if found.refused:
        return "", ask.why(found.res, limit=120) if found.res else "could not be listed"
    for dep in found.items:
        spec = (((dep.get("spec") or {}).get("template") or {}).get("spec") or {})
        for container in (spec.get("containers") or []):
            for env in (container.get("env") or []):
                if env.get("name") != WATCH_ENV:
                    continue
                # `valueFrom` (a fieldRef to the pod's own namespace) is the chart's
                # single-namespace default. It is a real answer -- own namespace only --
                # and not an unreadable one.
                if "value" not in env:
                    return ((dep.get("metadata") or {}).get("namespace") or ""), ""
                return str(env.get("value") or ""), ""
    return "", "no operator Deployment was found"

def operator_watches(scope: str, namespace: str) -> bool:
    """Whether `scope` covers `namespace`. `*` or empty-with-no-reason means all."""
    if scope in ("*", ""):
        return True
    return namespace in [p.strip() for p in scope.split(",") if p.strip()]


def _install_operator(context: str, emit: Emit) -> None:
    """Install houston's shared operator release after adoption checks pass."""
    kube.run(["helm", "repo", "add", OPERATOR_REPO, OPERATOR_REPO_URL, "--force-update"],
        timeout=APPLY_TIMEOUT, env=kubeexec.helm_env(context))
    kube.run(["helm", "repo", "update", OPERATOR_REPO], timeout=APPLY_TIMEOUT,
        env=kubeexec.helm_env(context))
    info(emit, f"MongoDB operator in {OPERATOR_NAMESPACE} (once per cluster)",
         phase="provision", pct=15)
    # A KILLED INSTALL WEDGES THIS FOR EVERY WORKSPACE ON THE CLUSTER, which is why
    # it matters more here than for a workspace's own release: `houston-system` is
    # shared, so one Ctrl-C inside the five-minute `--wait` leaves every later
    # `--mongo-operator` failing with "another operation is in progress".
    # `--rollback-on-failure` does not help -- a killed helm is not there to perform
    # the rollback -- so the release has to be freed the same way the workspace's is.
    kuberelease.clear_pending_release(OPERATOR_RELEASE, OPERATOR_NAMESPACE, context, emit=emit)
    res = kube.run(["helm", "upgrade", "--install", OPERATOR_RELEASE, OPERATOR_CHART,
               "--kube-context", context, "-n", OPERATOR_NAMESPACE,
               "--create-namespace", "--set", "operator.watchNamespace=*",
               # TELEMETRY OFF. The chart sends the cluster UID, the Kubernetes
               # version and deployment UIDs to MongoDB on a weekly timer, enabled by
               # default -- observed as a real `mongodb-kubernetes-operator-telemetry`
               # payload. Nobody using a support reproduction tool opted into third-
               # party analytics about the cluster they are debugging on, and on a
               # customer's adopted cluster houston would be the thing that started
               # it. Off is the only defensible default here; an operator who wants it
               # can install the chart themselves.
               "--set", "operator.telemetry.send.enabled=false",
               "--set", "operator.telemetry.collection.enabled=false",
               "--wait", "--timeout", "5m", *kuberelease.helm_rollback_on_failure()],
              timeout=INSTALL_TIMEOUT, env=kubeexec.helm_env(context))
    if res.returncode != 0:
        raise CreateFailedError("could not install the MongoDB operator: " + ask.why(res))


def ensure_operator(*, context: str, namespace: str = "",
                    emit: Emit = null_emit) -> None:
    """Install the MongoDB operator once for the cluster, watching all namespaces.

    Cluster-scoped by necessity, not by preference: the chart manages CRDs, and CRDs
    are not namespaced. Installing it per workspace collides on them at the second
    workspace, which is why the guide's placement -- inside the Rocket.Chat namespace
    -- cannot be followed literally by a tool that runs several at once.

    `upgrade --install` so a cluster that already has it is not an error, which is
    every workspace after the first.

    AND IT ADOPTS RATHER THAN INSTALLS when the operator is somebody else's. See
    `operator_presence` for why that question is asked of the CRD.
    """
    # ASKED BEFORE ANYTHING IS WRITTEN, including the helm repo add. Nothing below this
    # point should run on a cluster whose operator houston does not own.
    seen = operator_presence(context)
    if seen.state == REFUSED:
        # "I could not ask" is not "there is none", and the action on the other side of
        # this question installs CLUSTER-SCOPED CRDs. Getting it wrong on a shared
        # cluster reaches other people's databases, so this is the one place the
        # module's rule has to produce a refusal rather than a best guess.
        raise PreflightError(
            "cannot tell whether this cluster already has a MongoDB operator: the "
            f"{MONGODB_CRD} CRD could not be read ("
            + (ask.why(seen.res, limit=160) if seen.res else "no reason given") + "). "
            "Installing one anyway would take ownership of cluster-scoped CRDs that "
            "may belong to somebody else. Grant read on customresourcedefinitions, or "
            "run without `--mongo-operator` to use the chart's own MongoDB.")
    if seen.present and not operator_is_ours(seen):
        scope, unreadable = operator_watch_scope(context)
        # AGAINST THE NAMESPACE THIS WORKSPACE ACTUALLY GOES IN. houston's namespaces
        # are `houston-<name>`, a prefix and not one fixed name, so an operator
        # watching a list has to be checked against the real one. With no namespace to
        # check -- a caller that has not chosen one yet -- the scope is not a question
        # that can be answered, so it is not asked.
        if namespace and not unreadable and not operator_watches(scope, namespace):
            # A real answer, and it does not cover us. Said as a refusal rather than
            # left to become a five-minute `wait_for_mongodb` timeout on a workspace
            # whose database nothing was ever going to reconcile.
            raise PreflightError(
                f"this cluster has a MongoDB operator that houston did not install, "
                f"and it watches {scope!r} — which does not include {namespace!r}. "
                f"Installing a second cluster-scoped operator beside it would have "
                f"both reconcile the same resources. Ask whoever owns it to watch "
                f"`*`, or run without `--mongo-operator`.")
        adopted = ("watching " + (scope or "its own namespace") if not unreadable
                   else "scope unread: " + unreadable)
        info(emit, f"adopting the MongoDB operator already in this cluster ({adopted})"
                   f" — houston installs nothing and removes nothing",
             phase="provision", pct=15)
        return
    _install_operator(context, emit)

def mongodb_resources(context: str) -> list[str] | None:
    """Namespaces that still hold a `MongoDBCommunity`, i.e. still need the operator.

    Empty when the CRD is not installed at all, which is the answer, not an error --
    `--ignore-not-found` keeps a cluster that never had the operator from looking like
    a failure.
    """
    res = kube.run(["kubectl", "--context", context, "get", "mongodbcommunity", "-A",
               "--ignore-not-found", "-o",
               "jsonpath={range .items[*]}{.metadata.namespace}{\"\\n\"}{end}"],
              timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        # `None`, not `[]`: this is the SHARED operator's reference count, and an
        # empty one means "uninstall it". A read nobody could perform is not
        # evidence that nothing needs it.
        return None
    return sorted({ns for ns in (res.stdout or "").split() if ns})

def release_installed(release: str, namespace: str, context: str) -> bool:
    """Whether a helm release is in this cluster. Used before uninstalling one, so
    "there was nothing there" is reported as nothing rather than as a failure.

    Presence really is the question at those call sites -- a wedged release still
    needs uninstalling -- so this stays a bool and reads it from `release_state`.
    """
    try:
        return bool(kuberelease.release_state(release, namespace, context)[0])
    except DockerError:
        # These callers ask before an uninstall. Not knowing is not "absent", and the
        # uninstall itself reports its own failure honestly, so let it try.
        return True

def operator_installed(context: str) -> bool:
    """Whether the shared MongoDB operator release is in this cluster."""
    return release_installed(OPERATOR_RELEASE, OPERATOR_NAMESPACE, context)


def _uninstall_operator(context: str, emit: Emit) -> bool:
    """Remove houston's operator release while retaining its shared CRD."""
    info(emit, f"uninstalling the MongoDB operator from {OPERATOR_NAMESPACE} — "
               "nothing is using it now", phase="teardown")
    res = kube.run(["helm", "uninstall", OPERATOR_RELEASE, "--kube-context", context,
               "-n", OPERATOR_NAMESPACE, "--wait", "--timeout", "5m"],
              timeout=INSTALL_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        # Not an error worth failing a teardown for: the workspace is already gone and
        # the next `--mongo-operator` runs `upgrade --install`, which repairs it.
        warn(emit, "the MongoDB operator could not be uninstalled and is still "
                   f"running in {OPERATOR_NAMESPACE}: " + ask.why(res), phase="teardown")
        return False
    return True


def remove_operator(*, context: str, excluding: str = "",
                    emit: Emit = null_emit) -> bool:
    """Uninstall the shared MongoDB operator once nothing is using it any more.

    `down --volumes` means delete everything, so leaving an operator running afterwards
    is the wrong answer -- but three things about it are shared, and the ORDER is what
    makes removing it safe rather than destructive.

    **The custom resources go first, and they already have.** This is called after the
    workspace's namespace is deleted, which takes its `MongoDBCommunity` with it while
    the operator is still alive to clear the finalizer. Removing the operator first
    deadlocks on a resource nothing is left to finalise, and the namespace then sits in
    Terminating forever -- the identical failure `remove_monitoring` records for a
    GrafanaFolder, observed there on the first real uninstall.

    **The reference count is a real check, not bureaucracy.** With a second workspace
    still holding a `MongoDBCommunity`, removing the operator leaves its finalizer with
    nothing to clear it, so a later `down --volumes` on THAT workspace hangs. In the
    normal one-workspace case the check passes immediately and the operator goes.

    **The CRD stays.** `helm uninstall` does not remove it anyway, and deleting it would
    delete every `MongoDBCommunity` in the cluster -- every other workspace's database,
    instantly. It is inert without the operator and the next `--mongo-operator` reuses
    it. Same for the namespace: `houston-system` is shared with the monitoring stack.
    """
    # OURS, DELIBERATELY, and this is the guard that makes adoption safe: an operator
    # houston adopted was never installed as our release, so this answers False for it
    # and the uninstall below is never reached. houston removes what houston put
    # there and nothing else -- the mirror of `ensure_operator` adopting rather than
    # installing over somebody else's.
    if not operator_installed(context):
        return False
    # `excluding` for the same reason `remove_monitoring` takes it: the workspace being
    # destroyed must not be counted as still needing the operator. Its MongoDBCommunity
    # is normally gone by the time the namespace finishes, but "normally" is a race, and
    # losing it leaves the operator running with nothing at all using it.
    using = mongodb_resources(context)
    if using is None:
        warn(emit, "not removing the shared MongoDB operator: its MongoDBCommunity "
                   "resources could not be listed, so whether another workspace "
                   "still needs it is unknown. Removing it would leave their "
                   "finalizers with nothing to clear.", phase="teardown")
        return False
    still = [ns for ns in using if ns != excluding]
    if still:
        info(emit, "leaving the MongoDB operator up — still used by "
                   + ", ".join(n.removeprefix(NAMESPACE_PREFIX) for n in still),
             phase="teardown")
        return False
    return _uninstall_operator(context, emit)

def wait_for_mongodb(*, namespace: str, context: str, emit: Emit = null_emit,
                     sleep=time.sleep) -> None:
    """Wait for the operator to report the MongoDBCommunity Running.

    The operator owns initiation and readiness, so this asks IT rather than poking
    mongod -- which is the whole point of using it. `.status.phase` is the resource's
    own answer; there is no exec, no rs.initiate and no readiness probe to race.
    """
    for attempt in range(tuning.MONGO_READY_TRIES):
        res = kube.run(["kubectl", "--context", context, "-n", namespace, "get",
                   "mongodbcommunity", MONGO_SERVICE, "-o",
                   "jsonpath={.status.phase}"], own=vocab.is_ours(context))
        if (res.stdout or "").strip() == "Running":
            info(emit, "MongoDB ready (operator-managed, SCRAM)", phase="boot")
            return
        if attempt % 6 == 0:
            info(emit, "waiting for the operator to bring MongoDB up", phase="wait")
        sleep(MONGO_READY_INTERVAL)
    # Say what the resource itself reports. An empty phase means the operator never
    # reconciled it at all -- which is what an unusable `spec.version` looks like,
    # and "did not come up" sent me to the wrong place for it.
    detail = kube.run(["kubectl", "--context", context, "-n", namespace, "get",
                  "mongodbcommunity", MONGO_SERVICE, "-o",
                  "jsonpath={.status.phase}{\" \"}{.status.message}"],
                 own=vocab.is_ours(context))
    said = (detail.stdout or "").strip()
    raise CreateFailedError(
        "the operator did not bring MongoDB up"
        + (f" — it reports: {said}" if said else
           " — and reports no status at all, which means it never reconciled the "
           "resource (usually an unusable spec.version)")
        + f". kubectl -n {namespace} describe mongodbcommunity {MONGO_SERVICE}")
