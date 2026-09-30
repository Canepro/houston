"""`houston.services.k8s.manifests`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _completed
import json
import pytest


def test_the_readiness_probe_can_answer_before_the_set_is_initiated():
    """The manifest half of the same bug. A probe that cannot pass until initiation
    keeps the pod unready forever, and Kubernetes gives no hint that the PROBE is
    the problem."""
    import yaml

    from houston.services import k8s

    sts = [d for d in yaml.safe_load_all(k8s.mongo_manifest("t", "8.0"))
           if d["kind"] == "StatefulSet"][0]
    cmd = sts["spec"]["template"]["spec"]["containers"][0]["readinessProbe"]["exec"]["command"]
    assert any("directConnection=true" in part for part in cmd), cmd


def test_the_chart_fix_is_applied_only_where_the_chart_needs_it(monkeypatch):
    """Rocket.Chat 7.x could not install on Kubernetes at all, and no test saw it
    because every live run used 8.5.1.

    Chart 6.26.0 -- the exact-match chart for RC 7.10.0 -- ships
    `containerSecurityContext: {runAsUser: 999, fsGroup: 999}` and renders it onto
    the CONTAINER, where `fsGroup` does not exist. Helm 3 applied client-side and
    dropped it silently; Helm 4 applies server-side and the API server refuses the
    whole Deployment: ".spec.template.spec.containers[name=\\"rocketchat\\"]
    .securityContext.fsGroup: field not declared in schema".

    `null` is the override because Helm MERGES values -- passing a replacement map
    leaves the chart's own fsGroup underneath and changes nothing. And it is applied
    only where the chart has the field: injecting it into chart 7.0.0, which fixed
    the bug upstream, put a literal `fsGroup: null` onto the container instead --
    the same undeclared field from the other direction.
    """
    from houston.services import k8s

    def fake_run(argv, **kw):
        import subprocess
        has_fsgroup = "6.26.0" in argv
        body = ("containerSecurityContext:\n  runAsUser: 999\n  fsGroup: 999\n"
                if has_fsgroup else
                "containerSecurityContext:\n  runAsUser: 65533\n")
        return subprocess.CompletedProcess(argv, 0, stdout=body, stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    assert k8s.container_security_context("6.26.0") == \
        {"containerSecurityContext": {"fsGroup": None}}
    assert k8s.container_security_context("7.0.0") == {}, \
        "a chart without the field must get no override at all"


def test_a_mongo_tag_cannot_add_structure_to_the_statefulset():
    """`mongo_manifest` builds YAML by f-string, and `--mongo` is a plain CreateReq
    field that `POST /api/repros` copies straight from the body -- and is NOT in
    PRIVILEGED_CREATE_FIELDS, so any member+ GUI account could reach it.

    Pre-fix this rendered `privileged: true` and `hostPID: true` into a valid
    two-document manifest that `kubectl apply` accepts, bypassing the very control
    that exists to stop a member choosing what code runs.
    """
    from houston.services import k8s

    hostile = ("8.0\n        securityContext:\n          privileged: true\n"
               "        hostPID: true\n        # ")
    with pytest.raises(errors.ValidationError, match="not a MongoDB image tag"):
        k8s.mongo_manifest("t", hostile)
    # The legitimate tags this runtime actually uses are untouched.
    for good in ("8.0", "7.0.14", "6.0.5-ubi8", "latest"):
        assert k8s.mongo_manifest("t", good), good


def test_what_was_deployed_is_written_next_to_repro_json(tmp_path, monkeypatch):
    """A Compose workspace has a docker-compose.yml you can read; a Kubernetes one
    had only repro.json, because values go to `helm --values -` and manifests to
    `kubectl apply -f -` on stdin. Good for secrets, bad for answering "what did it
    actually deploy" -- especially once the cluster is gone and `helm get values` is
    no longer there to ask.

    Written for READING: re-running `up` regenerates them, exactly as it regenerates
    docker-compose.yml.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import k8s

    written = k8s.record_rendered(
        "w",
        values={"image": {"tag": "8.5.1"}, "existingMongodbSecret": "rocketchat-mongodb-url"},
        manifests={"mongodb": "kind: StatefulSet\n", "scenario": "kind: Deployment\n"})

    base = tmp_path / "repros" / "w" / "kubernetes"
    assert (base / "values.yaml").exists()
    assert (base / "mongodb.yaml").read_text() == "kind: StatefulSet\n"
    assert (base / "scenario.yaml").read_text() == "kind: Deployment\n"
    assert len(written) == 3, written

    # The values name the Secret; they must never CONTAIN the password. Moving the
    # MongoDB URL off `helm get values` was the point of v0.49.0, and writing it to
    # a file here would undo exactly that.
    body = (base / "values.yaml").read_text()
    assert "existingMongodbSecret" in body
    assert "mongodb://" not in body, body


def _a_workspace_ready_to_upgrade(monkeypatch):
    """A running chart release, and the helm calls an upgrade would make against it."""
    from houston.services import k8s

    seen: list = []
    sent: list = []

    def fake(argv, **kw):
        seen.append(argv)
        sent.append(kw.get("input") or "")
        return _completed(0)

    monkeypatch.setattr(k8s.subprocess, "run", fake)
    # STUBBED AT THE `run` SEAM, not at `release_values`, deliberately: a test that
    # monkeypatches the new function fails against the old code with AttributeError,
    # which proves a rename rather than a defect. Answering `helm get values` here
    # means the assertions below run against either version and fail on BEHAVIOUR.
    release = {"containerSecurityContext": {"fsGroup": None},
               "externalMongodbUrl": "mongodb://keep-me",
               "microservices": {"enabled": True},
               "externalMongodbOplogUrl": "mongodb://local",
               "image": {"repository": "old", "tag": "7.4.0"}}
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(
        0, out=json.dumps(release) if "get" in argv else ""))
    # The TARGET chart has no `fsGroup` on the container, so nothing should be sent.
    monkeypatch.setattr(k8s.manifests, "container_security_context", lambda cv: {})

    k8s.upgrade_image(namespace="ns", context="c", chart_version="7.0.0",
                      image_repo="r", tag="8.0.0", oplog=False)

    argv = seen[-1]
    return argv, k8s, sent


def test_the_upgrade_re_supplies_the_values_file_like_the_official_guide(monkeypatch):
    """The guide says: change the image tag in your values.yaml and run `helm
    upgrade`. This did `--reuse-values` instead, and two things broke.

    `--reuse-values` never applies the NEW chart's defaults (helm: "reuse the last
    release's values and merge in any overrides"), so a chart that ADDS a templated
    value renders against a map without it -- RC 7.4.0 -> 7.10.15 crosses chart
    6.23.2 -> 6.26.0, which added `podMonitor`, and it died on `nil pointer
    evaluating interface {}.enabled`.

    Worse, it carries per-chart-version workarounds. `containerSecurityContext:
    {fsGroup: null}` is REQUIRED on chart 6.26.0 and BREAKS chart 7.0.0, which fixed
    the problem upstream -- so carrying it across that upgrade reintroduces the bug
    it exists to fix. `--reset-then-reuse-values` does not save this either: it still
    re-applies the last release's values over the new defaults. Only re-supplying a
    values file, with that key recomputed against the TARGET chart, is correct.
    """
    argv, k8s, sent = _a_workspace_ready_to_upgrade(monkeypatch)
    assert argv[:2] == ["helm", "upgrade"]
    assert "--values" in argv and "-" in argv, argv
    assert not any("reuse-values" in a for a in argv), \
        "a reuse flag is back; the guide supplies the whole file"
    assert not any(a == "--set" for a in argv), \
        "the tag goes in the values file, the way the guide changes it"

    body = json.loads(sent[-1])
    assert body["image"] == {"repository": "r", "tag": "8.0.0"}
    assert body["externalMongodbUrl"] == "mongodb://keep-me", \
        "create-time decisions must survive the upgrade"
    assert body["microservices"] == {"enabled": True}
    assert "containerSecurityContext" not in body, \
        "a workaround for the OLD chart was carried onto the new one"
    assert "externalMongodbOplogUrl" not in body, \
        "RC 8 dropped oplog tailing; the key is removed, not carried"

    # And where the target chart DOES need it, it is present -- recomputed, not reused.
    monkeypatch.setattr(k8s.manifests, "container_security_context",
                        lambda cv: {"containerSecurityContext": {"fsGroup": None}})
    k8s.upgrade_image(namespace="ns", context="c", chart_version="6.26.0",
                      image_repo="r", tag="7.10.15", oplog=False)
    assert json.loads(sent[-1])["containerSecurityContext"] == {"fsGroup": None}


def test_the_mongodb_manifest_satisfies_pod_security_restricted():
    """K-10. `mongo_manifest` set no securityContext at all, so under PSA
    `restricted` the StatefulSet was ACCEPTED and no pod was ever created -- and
    every diagnostic went blind: `terminal_pod_failure` found no pod, `pod_rows` was
    empty, `storage_blocker` said nothing, and the PVC sat Pending pointing at
    storage, which was not the problem.

    Verified live against a namespace labelled `enforce=restricted`: pre-fix the API
    server rejected the pod with all four violations named; post-fix it Runs, mongod
    is uid 999, and the replica set reaches PRIMARY.
    """
    import yaml as _yaml

    from houston.services import k8s

    sts = [d for d in _yaml.safe_load_all(k8s.mongo_manifest("t", "8.0"))
           if d and d["kind"] == "StatefulSet"][0]
    pod = sts["spec"]["template"]["spec"]
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert pod["securityContext"]["seccompProfile"]["type"] == "RuntimeDefault"
    container = pod["containers"][0]
    assert container["securityContext"]["allowPrivilegeEscalation"] is False
    assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
    # Requests so a namespace quota cannot reject the pod outright; no CPU limit,
    # because throttling mongod during a restore turns a backup test into a timeout.
    assert container["resources"]["requests"]["memory"]
    assert "cpu" not in container["resources"].get("limits", {})


def test_a_storage_class_does_not_break_the_document_it_is_written_into():
    """`storage_class=` produced YAML no Kubernetes client can parse.

    `sc_line` was indented eight spaces and spliced in beside `accessModes`, which
    sits at six -- so `storageClassName` became a child of a scalar and kubectl
    answered `error converting YAML to JSON: yaml: line 72: did not find expected
    key`. Not a wrong field or a wrong value: the whole two-document manifest is
    unparseable, so the Service goes in with it and nothing is created.

    Found by `tools/parity-manifests.js`, which sends both implementations'
    manifests to a real API server with `--dry-run=server`. Nothing in `houston/`
    passes this argument today, which is why it survived -- the parameter is
    documented, public, and has never once produced a usable document.
    """
    import yaml

    from houston.services import k8s

    doc = k8s.mongo_manifest("t", "8.0", storage_class="local-path")
    sts = [d for d in yaml.safe_load_all(doc) if d["kind"] == "StatefulSet"][0]
    claim = sts["spec"]["volumeClaimTemplates"][0]
    assert claim["spec"]["storageClassName"] == "local-path", claim["spec"]
    # And it belongs to the CLAIM's spec, not to the template item: the same
    # mis-indentation one level out is what put labels beside `metadata` once.
    assert "storageClassName" not in claim, claim
