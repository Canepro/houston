"""`houston.services.k8s.operator`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_through
from servicehelpers import _completed, _crd, _helm_list
import pytest
import subprocess


def test_mongodb_uses_the_operator_where_it_can_and_the_statefulset_where_it_cannot(
        monkeypatch, tmp_path):
    """Keyed on the MongoDB VERSION, which is the shape `mongo_flavor` already uses
    on the Compose side ("official" >= 8, "bitnami-legacy" below).

    houston pairs twelve MongoDB versions -- 3.0 through 8.2 -- because "the
    customer's exact version" is the product's promise, and the operator's window
    does not reach the old half. So this is not operator-or-StatefulSet; it is
    operator where it works, StatefulSet where it must, decided by one rule.
    """
    from houston.services import k8s

    # The version rule, with the operator switched on -- it is opt-in by default
    # until its PVC binds on a live cluster (see the opt-in test).
    monkeypatch.setenv(k8s.USE_OPERATOR_ENV, "1")
    for old in ("3.6", "4.4", "5.0"):
        assert not k8s.operator_supports(old), old
    for new in ("6.0", "7.0", "8.0", "8.2"):
        assert k8s.operator_supports(new), new
    assert not k8s.operator_supports("nonsense")


def test_the_operator_is_installed_once_per_cluster_not_once_per_workspace(
        monkeypatch, tmp_path):
    """The guide installs the operator INTO the Rocket.Chat namespace, because it
    assumes one Rocket.Chat per cluster. Its CRDs are cluster-scoped, so a second
    per-namespace install collides on them rather than yielding a second operator --
    which is exactly what a tool running several workspaces at once would hit.

    So: one install, its own namespace, watching all of them.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: seen.append(" ".join(argv)) or
                        __import__("subprocess").CompletedProcess(argv, 0, "", ""))
    k8s.ensure_operator(context=k8s.CONTEXT)
    install = [c for c in seen if "upgrade --install" in c][0]
    assert f"-n {k8s.OPERATOR_NAMESPACE}" in install, install
    assert "houston-" not in install.split("-n ")[1].split()[0].replace(
        k8s.OPERATOR_NAMESPACE, ""), "it went into a workspace namespace"
    assert "operator.watchNamespace=*" in install, "it would not see other namespaces"
    # Idempotent: every workspace after the first re-runs this.
    assert "upgrade --install" in install


def test_the_mongo_uri_carries_credentials_and_the_operator_service_name():
    """The operator names its service `<name>-svc`, not `<name>` -- the two are not
    interchangeable, and the hand-written path uses the bare name."""
    from houston.services import k8s

    uri = k8s.operator_mongo_url("houston-t", "s3cret")
    assert "rocketchat:s3cret@" in uri
    assert "mongodb-0.mongodb-svc.houston-t.svc.cluster.local" in uri
    assert "authSource=rocketchat" in uri and "replicaSet=mongodb" in uri
    # The oplog URI points at `local` and needs no authSource.
    assert "/local?" in k8s.operator_mongo_url("houston-t", "s3cret", oplog=True)


def test_the_operator_gets_a_full_release_version_not_a_docker_tag():
    """houston carries a Docker TAG -- "8.0" -- because that is what pulls an image.
    The operator wants a RELEASE version, and the guide shows "8.0.0".

    Given "8.0" it accepts the resource and never reconciles it: no `.status.phase`
    at all, the operator healthy, MongoDB simply absent. The create then waited 300s
    and reported "the operator did not bring MongoDB up", which names nothing. Found
    on the first live run of the operator path.
    """
    import yaml

    from houston.services import k8s

    assert k8s.operator_version("8.0") == "8.0.0"
    assert k8s.operator_version("7.0") == "7.0.0"
    # An explicit --mongo 8.0.4 still means 8.0.4.
    assert k8s.operator_version("8.0.4") == "8.0.4"
    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "8.0"))
    assert doc["spec"]["version"] == "8.0.0", "a bare tag never reconciles"


def test_the_operator_is_opt_in_until_it_is_proven(monkeypatch):
    """A default that breaks the working case is worse than a missing feature.

    The hand-written StatefulSet was verified end to end on a live cluster -- admin
    login, PVC Bound, data surviving a down/up cycle. Routing MongoDB 6.0+ to the
    operator by default replaced that with a path whose PVC never binds:

        it reports: Pending ReplicaSet is not yet ready, retrying in 10 seconds
        data-volume-mongodb-0   Pending

    So the operator waits behind a flag. What that costs is auth, which is the
    thing it was adopted for -- and saying so is the point of this test.
    """
    from houston.services import k8s

    monkeypatch.delenv(k8s.USE_OPERATOR_ENV, raising=False)
    assert not k8s.operator_enabled()
    assert not k8s.operator_supports("8.0"), "a supported version must still not route"

    monkeypatch.setenv(k8s.USE_OPERATOR_ENV, "1")
    assert k8s.operator_enabled()
    assert k8s.operator_supports("8.0")
    assert not k8s.operator_supports("5.0"), "the version floor still applies"


def test_the_database_pod_gets_its_service_account_in_the_workspace_namespace():
    """What actually held the operator path at Pending for three sessions.

    The operator writes a StatefulSet whose pod runs as `mongodb-kubernetes-appdb`.
    Its chart creates that account only in the namespace the chart is installed
    into. houston installs the operator ONCE, in `houston-system`, because the
    chart owns cluster-scoped CRDs and a per-workspace install collides on them at
    the second workspace -- so the account is missing exactly where the pod needs it:

        error: pods "mongodb-0" is forbidden: error looking up service account
        houston-optest/mongodb-kubernetes-appdb: serviceaccount ... not found

    That is an event on the StatefulSet. The MongoDBCommunity resource reports only
    "Pending ReplicaSet is not yet ready", and because no pod is ever created,
    WaitForFirstConsumer holds both PVCs at Pending -- which is the symptom seen
    first and points at storage, which was never the problem.
    """
    import yaml

    from houston.services import k8s

    docs = {d["kind"]: d
            for d in yaml.safe_load_all(k8s.mongo_rbac_manifest("t", owner="o"))}
    assert set(docs) == {"ServiceAccount", "Role", "RoleBinding"}, sorted(docs)

    sa = k8s.MONGO_DB_SERVICE_ACCOUNT
    assert all(d["metadata"]["name"] == sa for d in docs.values())
    # The binding must name the LOCAL account. Pointing at the operator's namespace
    # would apply cleanly and still leave the pod unable to start.
    subject = docs["RoleBinding"]["subjects"][0]
    assert subject["kind"] == "ServiceAccount" and subject["name"] == sa
    assert "namespace" not in subject, "must bind the account in OUR namespace"
    assert docs["RoleBinding"]["roleRef"]["name"] == sa

    # Exactly what a member pod needs: read its own password Secret, and
    # patch/delete/get its own Pod to mark readiness and roll itself.
    rules = {r["resources"][0]: set(r["verbs"]) for r in docs["Role"]["rules"]}
    assert rules == {"secrets": {"get"}, "pods": {"patch", "delete", "get"}}, rules

    # Owned like everything else, so `prune` and the ownership guards see it.
    for doc in docs.values():
        assert doc["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "houston"


def test_asking_for_the_operator_explicitly_satisfies_the_opt_in_but_not_the_floor(
        monkeypatch):
    """`--mongo-operator` is the user asking for it, so the opt-in switch is met.
    The VERSION floor still applies: the operator cannot manage MongoDB 5.0, and
    silently ignoring the flag would be worse than falling back."""
    from houston.services import k8s

    monkeypatch.delenv(k8s.USE_OPERATOR_ENV, raising=False)
    assert not k8s.operator_supports("8.0"), "off by default"
    assert k8s.operator_supports("8.0", forced=True), "--mongo-operator asks for it"
    assert not k8s.operator_supports("5.0", forced=True), "the floor still holds"


def test_the_oplog_user_can_actually_read_the_oplog(monkeypatch):
    """Two faults in one line, on the only versions that use it.

    Rocket.Chat below 8.x tails the oplog; 8.x dropped it. The operator's oplog URL
    addressed the `local` DATABASE while the user is defined in `rocketchat`, and
    carried no authSource -- so the driver authenticated against `local`, looking for
    a user that has never existed there. Even past that, reading `local` needs a role
    `readWrite` on the app database does not confer.

    The role is not an invention: Rocket.Chat's own chart grants exactly this to its
    bundled MongoDB, in templates/mongodb-init-configmap.yaml --
    `grantRolesToUser('<user>', [{ role: 'clusterMonitor', db: 'admin' }])`.

    This survived every live run because they all used 8.5.1, where the URL is never
    emitted at all.
    """
    import yaml

    from houston.services import k8s

    oplog = k8s.operator_mongo_url("houston-x", "PW", oplog=True)
    assert "/local?" in oplog, oplog
    assert f"authSource={k8s.MONGO_APP_DB}" in oplog, \
        "without authSource the driver authenticates against `local`"

    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "7.0"))
    app = {u["name"]: u for u in doc["spec"]["users"]}[k8s.MONGO_APP_USER]
    roles = {(r["name"], r["db"]) for r in app["roles"]}
    assert ("readWrite", k8s.MONGO_APP_DB) in roles, roles
    assert ("clusterMonitor", "admin") in roles, \
        "readWrite on the app db cannot read `local`"


def _a_create_carrying_a_registration_token():
    """A create whose request carries the one field that must never reach a command line."""
    import yaml as _yaml

    from houston.services import k8s

    token = "SUPERSECRETTOKEN"

    # 1. The Secret carries it; the values only name the Secret.
    doc = _yaml.safe_load(k8s.reg_token_secret_manifest("w", token=token, owner="me"))
    return _yaml, doc, k8s, token


def test_the_registration_token_never_becomes_a_value_or_an_argument(monkeypatch):
    """The EE licence token reaches Rocket.Chat by REFERENCE, never as a literal.

    `--reg-token` was refused on this runtime, and the reason had outlived itself:
    "injected through the preset environment, which this runtime does not apply yet"
    -- preset env had been applied here for some time. Taken from PR #3, whose design
    is better than the obvious one, and the reason is exposure:

      * helm VALUES are readable with `helm get values` by anyone who can reach the
        release, and houston also writes them to `repros/<n>/kubernetes/values.yaml`
        for a human to read. That is precisely where the MongoDB password was moved
        out of, so putting a licence token there would undo the same lesson.
      * The manifest goes to `kubectl apply -f -` on STDIN, so the token is never a
        process argument either, where `ps` shows it to every user on the box.
    """
    _yaml, doc, k8s, token = _a_create_carrying_a_registration_token()
    assert doc["kind"] == "Secret" and doc["type"] == "Opaque"
    assert doc["stringData"][k8s.REG_TOKEN_KEY] == token
    assert doc["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "houston", \
        "teardown selects on ownership, so the Secret has to carry it"

    values = k8s.values_for(rc_version="8.5.1",
                            rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                            microservices=False,
                            mongo_url="mongodb://mongodb:27017/rocketchat",
                            reg_token_secret=k8s.REG_TOKEN_SECRET)
    assert token not in _yaml.safe_dump(values), \
        "the token must not be in anything `helm get values` can print"
    entry = next(e for e in values["extraEnv"] if e["name"] == "REG_TOKEN")
    assert entry["valueFrom"]["secretKeyRef"] == {"name": k8s.REG_TOKEN_SECRET,
                                                 "key": k8s.REG_TOKEN_KEY}
    assert "value" not in entry, "by reference, never by value"

    # 2. Without a token, nothing is referenced -- no dangling secretKeyRef.
    plain = k8s.values_for(rc_version="8.5.1",
                           rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                           microservices=False,
                           mongo_url="mongodb://mongodb:27017/rocketchat")
    assert not any(e["name"] == "REG_TOKEN" for e in plain["extraEnv"]), \
        "a workspace with no token must not reference a Secret that does not exist"

    # 3. Applied on stdin, so it is never visible in argv.
    seen = {}
    def fake_run(argv, **kw):
        import subprocess as sp
        seen["argv"] = argv
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s.subprocess, "run",
                        lambda argv, **kw: fake_run(argv, **kw))
    k8s.apply(k8s.reg_token_secret_manifest("w", token=token), namespace="ns",
              context="c")
    assert token not in " ".join(seen["argv"]), \
        "`ps` would show a token passed as an argument to every user on the box"
    assert "-f" in seen["argv"] and "-" in seen["argv"], "applied from stdin"


def test_the_no_auth_message_names_the_reason_that_actually_applies(monkeypatch):
    """It always said "no operator below 6.0, so no auth", and that was never the
    reason on any workspace anyone booted.

    `OPERATOR_MIN_MONGO` is (6, 0) and every supported Rocket.Chat resolves MongoDB to
    6.0, 7.0, 8.0 or 8.2, so the version floor is satisfied every time. The real
    reason is the other branch: the operator is OPT-IN and off. Somebody who wanted
    authentication was therefore sent to raise a MongoDB version that was not the
    obstacle -- while the workspace notes printed moments later said the true thing,
    so the two outputs contradicted each other.
    """
    from houston.services import k8s

    monkeypatch.delenv(k8s.USE_OPERATOR_ENV, raising=False)
    # The version floor is met for every version this tool actually pairs.
    for tag in ("6.0", "7.0", "8.0", "8.2"):
        parts = tuple(int(n) for n in tag.split("."))
        assert parts >= k8s.OPERATOR_MIN_MONGO, tag
        assert not k8s.operator_supports(tag), \
            "opt-in and off is the reason, not the version"
        assert k8s.operator_supports(tag, forced=True), \
            "forced, the same version IS supported -- so the floor was never the bar"

    # And 5.0 is the one case where the version really is the reason.
    assert not k8s.operator_supports("5.0", forced=True)

    # The source must offer both reasons rather than one. A walk, because this is a
    # message and no test would otherwise notice it going back to a single branch.
    body = source_through(k8s.create_workspace)
    assert "no authentication:" in body
    assert "opt-in" in body and "cannot manage MongoDB below" in body, (
        "the message must be able to name either reason")
    assert "no operator below" not in body, "the always-false wording is back"


def test_the_operator_resource_asks_for_scram_and_the_two_documented_users():
    """Auth was the gap the operator is being adopted for: without it an
    authentication ticket cannot be reproduced on Kubernetes at all. Users, roles
    and secret names match the official guide so its commands transfer."""
    import yaml

    from houston.services import k8s

    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "8.0"))
    assert doc["kind"] == "MongoDBCommunity"
    assert doc["spec"]["type"] == "ReplicaSet" and doc["spec"]["members"] == 1
    assert doc["spec"]["security"]["authentication"]["modes"] == ["SCRAM"]
    users = {u["name"]: u for u in doc["spec"]["users"]}
    assert users["admin"]["roles"][0]["name"] == "root"
    assert users["rocketchat"]["roles"][0]["name"] == "readWrite"
    assert users["rocketchat"]["scramCredentialsSecretName"] == \
        "rocketchat-scram-credentials"
    # The volume survives, as it does on the hand-written path.
    assert doc["spec"]["statefulSet"]["spec"]["volumeClaimTemplates"][0][
        "spec"]["resources"]["requests"]["storage"].endswith("Gi")


def test_the_operator_volume_claims_cover_both_volumes_the_pod_mounts():
    """The operator's pod mounts `data-volume` AND `logs-volume`, and overriding
    `volumeClaimTemplates` REPLACES its defaults rather than merging with them --
    a run that declared only `data-volume` produced exactly one PVC, while both of
    the pod's containers mount both volumes. A template list that drops one leaves
    the pod referencing a claim nothing creates.

    (This was NOT what held the first live run at Pending -- that was the missing
    ServiceAccount, see the RBAC test below. Both are real; only one was blocking.)
    """
    import yaml

    from houston.services import k8s

    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "8.0"))
    names = [v["metadata"]["name"]
             for v in doc["spec"]["statefulSet"]["spec"]["volumeClaimTemplates"]]
    assert names == ["data-volume", "logs-volume"], names


def _what_create_workspace_decides_about_an_unreadable_namespace(monkeypatch):
    """The structural half: a refused read must count as 'the namespace was already there'."""
    from houston.services import k8s

    denied = _completed(1, err='Error from server (Forbidden): namespaces is '
                               'forbidden: User "system:serviceaccount:x:limited" '
                               'cannot list resource "namespaces" at the cluster scope')
    monkeypatch.setattr(k8s.kube, "run", lambda a, **kw: denied)
    assert k8s.workspace_namespaces("limited") is None, \
        "a forbidden list read as an empty cluster"
    assert k8s.mongodb_resources("limited") is None

    # THE SHARED STACKS MUST BE LEFT ALONE. Both are reference-counted on a list that
    # could not be read, and both are used by other workspaces.
    said: list = []
    monkeypatch.setattr(k8s.operator, "release_installed", lambda *a, **kw: True)
    assert k8s.remove_monitoring(context="limited",
                                 emit=lambda e: said.append(e.message)) is False
    assert any("could not be read" in m for m in said), said
    said.clear()
    monkeypatch.setattr(k8s.operator, "operator_installed", lambda *a, **kw: True)
    assert k8s.remove_operator(context="limited",
                               emit=lambda e: said.append(e.message)) is False
    assert any("could not be listed" in m for m in said), said

    # AND A FAILED CREATE MUST NOT DELETE DATA IT COULD NOT PROVE WAS ITS OWN. This
    # is the data-loss one: `had_namespace` False sends the rollback into "removing
    # namespace", and the PVC goes with it after `down` promised it would be there.
    src = source_through(k8s.create_workspace)
    # DERIVED: the claim is that a refused read (`_held is None`) counts as "the
    # namespace was already there", not that the line is spelled a particular way. The
    # split turned `namespace_for(...)` into `kubens.namespace_for(...)` and a literal
    # match stopped testing anything -- FINDINGS 3c, again.
    import ast as _ast

    decided = [n.value for n in _ast.walk(_ast.parse(src))
               if isinstance(n, _ast.Assign)
               and any(getattr(t_, "id", "") == "had_namespace" for t_ in n.targets)]
    assert decided, "create_workspace no longer decides `had_namespace`"
    return _ast, decided, k8s


def test_a_cluster_that_cannot_be_listed_is_not_a_cluster_with_nothing_in_it(monkeypatch):
    """`workspace_namespaces` answered `[]` for a refused read, and three callers act
    on `[]` destructively.

    The realistic identity is a support engineer on a customer cluster with
    namespace-scoped RBAC -- no cluster-scoped verbs at all, so `get namespace` is
    Forbidden. An 8-second PROBE_TIMEOUT under load and a rolling control-plane
    restart produce the same answer.
    """
    _ast, decided, k8s = _what_create_workspace_decides_about_an_unreadable_namespace(monkeypatch)

    def counts_a_refusal(value) -> bool:
        """`<read> is None or ...` -- whatever the variable holding the read is called.

        The name was `_held` and 2b.15's extraction made it `held`, so asserting on the
        name reported the safety property gone when only the spelling had changed. What
        is being claimed is the SHAPE: an `or` whose left arm is an identity test
        against None, which is what makes an unanswerable read mean "it was already
        there" rather than "it was not".
        """
        if not (isinstance(value, _ast.BoolOp) and isinstance(value.op, _ast.Or)):
            return False
        return any(isinstance(v, _ast.Compare)
                   and any(isinstance(o, _ast.Is) for o in v.ops)
                   and any(isinstance(c, _ast.Constant) and c.value is None
                           for c in v.comparators)
                   for v in value.values)

    assert all(counts_a_refusal(v) for v in decided), \
        "a refused read must count as 'the namespace was already there'"

    # And a cluster whose contents are unknown is not an empty cluster to reclaim.
    from houston.errors import ConflictError
    monkeypatch.setattr(k8s.tools, "which", lambda n: "/usr/bin/kind")
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], False))
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: k8s.CONTEXT)
    monkeypatch.setattr(k8s.reachability, "reachable", lambda c: True)
    with pytest.raises(ConflictError) as caught:
        k8s.delete_cluster()
    assert "could not be read" in str(caught.value), caught.value


def test_both_shared_releases_free_a_wedged_one_before_installing():
    """A killed `helm install` wedges the SHARED releases for every workspace on the
    cluster, and only the workspace's own release knew how to recover.

    `houston-system` holds the MongoDB operator and the monitoring stack, so one
    Ctrl-C inside their five-minute `--wait` left every later `--mongo-operator` and
    every `--monitor` failing with "another operation (install/upgrade/rollback) is
    in progress". `--rollback-on-failure` does not cover it: a killed helm is not
    there to perform the rollback.
    """

    from houston.services import k8s

    for fn in (k8s.ensure_operator, k8s.ensure_monitoring, k8s.install):
        src = source_through(fn)
        assert "clear_pending_release" in src, (
            f"{fn.__name__} cannot recover a release a killed helm left pending")


def test_the_mongodb_operator_goes_with_the_last_workspace_but_not_before(monkeypatch):
    """`--volumes` means delete everything, and an operator left running afterwards is
    the wrong answer -- but three things about it are shared, and the ORDER is what makes
    removing it safe rather than destructive.

    The reference count is not bureaucracy: with a second workspace still holding a
    `MongoDBCommunity`, removing the operator leaves its finalizer with nothing to clear
    it, so a later `down --volumes` on THAT workspace hangs in Terminating forever. It is
    the identical failure `remove_monitoring` recorded for a GrafanaFolder.
    """
    import subprocess as sp

    from houston.services import k8s

    calls = []

    def fake(mongodbs, installed=True, rc=0):
        def run(argv, timeout=None, own=False, env=None, input=None):
            calls.append(" ".join(argv))
            j = " ".join(argv)
            if "helm list" in j:
                return sp.CompletedProcess(
                    argv, 0, _helm_list(k8s.OPERATOR_RELEASE) if installed else "[]", "")
            if "get mongodbcommunity" in j:
                return sp.CompletedProcess(argv, 0, "\n".join(mongodbs), "")
            return sp.CompletedProcess(argv, rc, "", "boom" if rc else "")
        return run

    # Nothing left that needs it: the operator goes.
    calls.clear()
    monkeypatch.setattr(k8s.kube, "run", fake([]))
    assert k8s.remove_operator(context="default") is True
    assert any("helm uninstall " + k8s.OPERATOR_RELEASE in c for c in calls), calls
    # The CRD is never touched: deleting it would delete every MongoDBCommunity in the
    # cluster, i.e. every other workspace's database.
    assert not any("delete crd" in c for c in calls), calls
    # Nor the namespace, which is shared with the monitoring stack.
    assert not any("delete namespace" in c for c in calls), calls

    # Another workspace still has one: left alone, and it says whose.
    calls.clear()
    events = []
    monkeypatch.setattr(k8s.kube, "run", fake(["houston-other"]))
    assert k8s.remove_operator(context="default", emit=events.append) is False
    assert not any("helm uninstall" in c for c in calls), calls
    assert any("still used by other" in e.message for e in events), \
        [e.message for e in events]

    # A cluster that never had it is not an error and says nothing.
    calls.clear()
    monkeypatch.setattr(k8s.kube, "run", fake([], installed=False))
    assert k8s.remove_operator(context="default") is False
    assert not any("helm uninstall" in c for c in calls), calls


def test_removing_the_operator_never_fails_a_teardown(monkeypatch):
    """The workspace is already gone by the time this runs, and the next
    `--mongo-operator` is an `upgrade --install` that repairs it. A teardown that reports
    failure for wreckage it cannot help would leave a user believing their workspace is
    still there."""
    import subprocess as sp

    from houston.services import k8s

    def run(argv, timeout=None, own=False, env=None, input=None):
        j = " ".join(argv)
        if "helm list" in j:
            return sp.CompletedProcess(argv, 0, _helm_list(k8s.OPERATOR_RELEASE), "")
        if "get mongodbcommunity" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        return sp.CompletedProcess(argv, 1, "", "uninstall exploded")

    monkeypatch.setattr(k8s.kube, "run", run)
    events = []
    assert k8s.remove_operator(context="default", emit=events.append) is False
    assert any("could not be uninstalled" in e.message for e in events)


def test_a_mongodb_operator_somebody_else_installed_is_adopted_not_installed_over(
        monkeypatch):
    """The one place the project's own adoption principle was not applied.

    cert-manager is keyed on `certificates.cert-manager.io` and ingress on any existing
    IngressClass, so both ADOPT a foreign install -- `cert_manager_installed`'s docstring
    states the reason: "the release can be named anything". The MongoDB operator asked
    instead whether houston's OWN release existed in houston's OWN namespace, so a
    platform team's operator was invisible and `helm upgrade --install` ran regardless.

    On a shared cluster that is a second cluster-scoped controller with
    `watchNamespace=*` reconciling `MongoDBCommunity` resources belonging to workloads
    houston knows nothing about, and a chart-version difference reaching cluster-scoped
    CRDs another install owns.
    """
    from houston.services import k8s

    ran: list = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: ran.append(list(argv)) or
                        subprocess.CompletedProcess(list(argv), 0, "", ""))
    monkeypatch.setattr(k8s.operator, "operator_watch_scope", lambda ctx: ("*", ""))
    monkeypatch.setattr(k8s.operator, "operator_presence",
                        lambda ctx: k8s.Answer(k8s.PRESENT,
                                               _crd("mongodb-operator", "platform")))
    said: list = []
    k8s.ensure_operator(context="c", namespace="houston-t1",
                        emit=lambda e: said.append(e.message))
    assert not [a for a in ran if a[:2] == ["helm", "upgrade"]], \
        "it installed a second cluster-scoped operator over somebody else's"
    assert any("adopting" in m for m in said), said

    # AND IT STILL INSTALLS ITS OWN. Adoption must not become "never install", or the
    # ordinary case -- an empty cluster -- silently stops working.
    ran.clear()
    monkeypatch.setattr(k8s.operator, "operator_presence", lambda ctx: k8s.Answer(k8s.ABSENT))
    k8s.ensure_operator(context="c", namespace="houston-t1")
    assert [a for a in ran if a[:2] == ["helm", "upgrade"]], ran

    # AND A CRD THAT IS OUR OWN RELEASE IS UPGRADED, not adopted -- that is every
    # workspace after the first on houston's own cluster.
    ran.clear()
    monkeypatch.setattr(k8s.operator, "operator_presence",
                        lambda ctx: k8s.Answer(k8s.PRESENT,
                                               _crd(k8s.OPERATOR_RELEASE,
                                                    k8s.OPERATOR_NAMESPACE)))
    k8s.ensure_operator(context="c", namespace="houston-t1")
    assert [a for a in ran if a[:2] == ["helm", "upgrade"]], ran


def test_an_unreadable_crd_refuses_rather_than_installing_cluster_scoped_resources(
        monkeypatch):
    """"I could not ask" is not "there is none", and here the action on the other side
    of that question installs CLUSTER-SCOPED CRDs.

    Everywhere else in this module the safe response to REFUSED is to leave a thing
    listed and say it could not be read. Here the safe response is a refusal, because
    guessing "no operator" reaches other people's databases.
    """
    from houston import errors
    from houston.services import k8s

    ran: list = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: ran.append(list(argv)) or
                        subprocess.CompletedProcess(list(argv), 0, "", ""))
    monkeypatch.setattr(k8s.operator, "operator_presence", lambda ctx: k8s.Answer(
        k8s.REFUSED, None,
        subprocess.CompletedProcess([], 1, "", "forbidden: crds")))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_operator(context="c", namespace="houston-t1")
    assert "forbidden" in str(exc.value), "the refusal must say what the cluster said"
    assert "customresourcedefinitions" in str(exc.value), \
        "and name the permission that would fix it"
    assert not ran, "nothing may be written on a question that could not be answered"


def test_an_operator_that_does_not_watch_this_namespace_is_refused_not_waited_on(
        monkeypatch):
    """Adopting an operator that will never reconcile this workspace turns into a
    five-minute `wait_for_mongodb` timeout about a database nothing was coming for.

    The scope is a real answer when it can be read, so it is acted on. When it cannot
    be read, adoption still happens -- adopting installs nothing, which is the
    conservative action, and refusing on ignorance would break every cluster whose
    operator simply could not be introspected.
    """
    from houston import errors
    from houston.services import k8s

    ran: list = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: ran.append(list(argv)) or
                        subprocess.CompletedProcess(list(argv), 0, "", ""))
    monkeypatch.setattr(k8s.operator, "operator_presence",
                        lambda ctx: k8s.Answer(k8s.PRESENT, _crd("theirs", "platform")))
    monkeypatch.setattr(k8s.operator, "operator_watch_scope", lambda ctx: ("platform,apps", ""))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_operator(context="c", namespace="houston-t1")
    assert "houston-t1" in str(exc.value) and "platform,apps" in str(exc.value)
    assert not ran

    # Unreadable scope -> adopt anyway, and say the scope was not read.
    monkeypatch.setattr(k8s.operator, "operator_watch_scope", lambda ctx: ("", "RBAC denied"))
    said: list = []
    k8s.ensure_operator(context="c", namespace="houston-t1",
                        emit=lambda e: said.append(e.message))
    assert any("adopting" in m and "RBAC denied" in m for m in said), said
    assert not [a for a in ran if a[:2] == ["helm", "upgrade"]], ran
