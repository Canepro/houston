"""`houston.services.topology`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston import presets
from houston.services import lifecycle as lc
from servicehelpers import _completed
import json
import pytest


# --- the topology socket --------------------------------------------------------
# Phase 1 of Kubernetes support: a workspace's runtime becomes a value that can be
# READ, instead of a shape (`docker-compose.yml` on disk) that can only be
# inferred. Only compose is registered, so none of this is user-visible yet -- the
# tests below are what make the seam checkable before there is a second runtime.

def test_a_workspace_with_no_runtime_key_reads_as_docker():
    """The compatibility gate. Every workspace on every existing box predates this
    key, and none of them is rewritten -- so an absent value must mean docker, or
    the socket silently orphans the entire installed base."""
    from houston.services import topology

    old = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                          mongo_tag="8.0", mongo_flavor="official", preset="default",
                          root_url="http://localhost:3000", host_port=3000,
                          version_source="test")
    assert old.extra == {}, "the fixture must genuinely lack the key"
    assert topology.of_meta(old) == topology.DOCKER


def test_an_unknown_runtime_reads_as_docker_rather_than_raising():
    """Forward compatibility, and the reason `of_meta` never raises: a workspace
    written by a NEWER houston naming a runtime this build has never heard of must
    still list and still tear down. A repro the installed version cannot remove is
    worse than one it renders imprecisely."""
    from houston.services import topology

    m = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="u", host_port=3000, version_source="t",
                        extra={"runtime": "nomad"})
    assert topology.of_meta(m) == topology.DOCKER
    # And a corrupt `extra` is survivable too -- runner already defends against it.
    broken = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                             mongo_tag="8.0", mongo_flavor="official", preset="default",
                             root_url="u", host_port=3000, version_source="t")
    broken.extra = "not-a-dict"          # type: ignore[assignment]
    assert topology.of_meta(broken) == topology.DOCKER


def test_the_runtime_survives_a_real_write_and_read(monkeypatch, tmp_path):
    """Round-trip through repro.json on disk, not through a mock. `read_meta`
    filters unknown keys, so a value living in the wrong place would be dropped
    between writing a workspace and reading it back."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "services: {}\n", m)
    assert topology.of_repro("k") == topology.KUBERNETES
    assert lc.runner.read_meta("k").extra["runtime"] == "kubernetes"


def test_reading_the_runtime_of_a_missing_workspace_does_not_explode(tmp_path, monkeypatch):
    """`of_repro` is called before the caller's own existence check in some paths.
    It must not be the thing that fails, or the user gets a stat error instead of
    'no such repro'."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert topology.of_repro("nope") == topology.DOCKER


def test_normalize_accepts_what_people_type_and_refuses_what_they_mistype():
    """The opposite policy to `of_meta`: this reads input a human just typed, where
    a silent fallback would boot the wrong topology."""
    from houston.services import topology

    assert topology.normalize("") == topology.DOCKER, "omitting --runtime is not an error"
    assert topology.normalize(None) == topology.DOCKER
    for spelling in ("docker", "compose", "docker-compose", "DOCKER"):
        assert topology.normalize(spelling) == topology.DOCKER
    for spelling in ("k8s", "kube", "Kubernetes", " KUBERNETES "):
        assert topology.normalize(spelling) == topology.KUBERNETES
    with pytest.raises(errors.ValidationError) as caught:
        topology.normalize("nomad")
    assert caught.value.exit_code == 2, "a typo is a usage error, not a preflight one"
    assert "kubernetes" in str(caught.value), "the refusal lists what IS known"


def test_a_compose_only_operation_refuses_a_kubernetes_workspace(monkeypatch, tmp_path):
    """`stats` shells out to `docker stats` against a compose project, so it cannot
    serve a workspace that has no compose project. The refusal must name the
    alternative -- 'not supported' leaves the user to find what the person writing
    the message already knew."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "services: {}\n", m)

    with pytest.raises(errors.ValidationError) as caught:
        topology.require_compose("k", "stats", instead="Use `kubectl top`.")
    assert "Kubernetes" in str(caught.value)
    assert "kubectl top" in str(caught.value), "the alternative is stated"

    # And it is SILENT for the runtime it is guarding -- a guard that fires on
    # compose would break every existing user of the command.
    topology.stamp(m.extra, topology.DOCKER)
    lc.runner.write("k", "services: {}\n", m)
    topology.require_compose("k", "stats")


def test_both_runtimes_are_registered_and_a_third_would_not_be():
    """Kubernetes joined `REGISTERED` only once its whole sequence -- cluster,
    namespace, MongoDB with an initiated replica set, the chart, a port-forward --
    ran on a live cluster rather than in stubs.

    Registration is what `up` consults, and it is deliberately separate from being
    SPELLABLE: a name can be recognised, and reported honestly as unavailable,
    before it works. That is how `kubernetes` behaved for six commits.
    """
    from houston.services import topology

    assert topology.REGISTERED == frozenset({topology.DOCKER, topology.KUBERNETES})
    assert topology.is_registered(topology.DOCKER)
    assert topology.is_registered(topology.KUBERNETES)
    assert not topology.is_registered("nomad")
    assert topology.normalize("k8s") == topology.KUBERNETES


# --- the three axes -------------------------------------------------------------

def test_every_cell_of_the_runtime_deployment_matrix():
    """`--preset` used to carry two ideas at once -- the scenario AND the
    deployment shape -- because there was one axis to put them in. Of the nine
    presets shipped, eight are scenarios and exactly one, multi-instance, is a
    deployment: it adds a Traefik load balancer and a NATS mesh.

    Splitting them means `--preset` finally means the same thing in both runtimes.
    Every combination is decided in one function, because a rule enforced at two
    call sites eventually disagrees with itself.
    """
    from houston.services import topology as T

    ok = lambda **kw: T.resolve_axes(**kw)                                # noqa: E731

    # Defaults: omitting --runtime is the common case, not an error.
    assert (ok().runtime, ok().deployment, ok().replicas) == (T.DOCKER, T.MONOLITH, 1)
    # Kubernetes defaults to microservices, matching the chart's own default.
    k = ok(runtime="k8s")
    assert (k.runtime, k.deployment) == (T.KUBERNETES, T.MICROSERVICES)
    assert ok(runtime="k8s", deployment="monolith").deployment == T.MONOLITH
    # A scenario is a scenario regardless of where it runs -- the whole point.
    assert ok(preset="ldap").preset == "ldap"
    assert ok(runtime="k8s", preset="ldap").preset == "ldap"
    # multi-instance reaches the preset loader, which is how it stays compatible.
    m = ok(deployment="multi-instance", replicas=3)
    assert (m.preset, m.params["instances"], m.replicas) == ("multi-instance", 3, 3)
    assert ok(deployment="multi-instance").replicas == 2, "the preset's own default"


def test_the_refusals_name_what_to_do_instead(monkeypatch):
    """Each refusal is about coverage or physics -- never about category
    confusion. 'Is multi-instance a preset or a deployment?' stops being a
    question a user can get wrong, because there is one place it can live."""
    from houston.services import topology as T

    cases = [
        (dict(runtime="docker", deployment="microservices"), "--runtime kubernetes"),
        (dict(runtime="k8s", deployment="multi-instance"), "--runtime docker"),
        (dict(replicas=3), "--deployment multi-instance"),
        (dict(preset="ldap", deployment="multi-instance"), "separately"),
        (dict(preset="multi-instance", deployment="monolith"), "two different deployments"),
        (dict(runtime="nomad"), "Known runtimes"),
        (dict(deployment="sharded"), "Known deployments"),
        (dict(replicas=-1), "at least 1"),
    ]
    for kwargs, expect in cases:
        with pytest.raises(errors.ValidationError) as caught:
            T.resolve_axes(**kwargs)
        assert expect in str(caught.value), f"{kwargs} said {caught.value!r}"
        assert caught.value.exit_code == 2, "a bad combination is a usage error"

    # Resolving and being allowed stay separate questions, so a GUI can name a
    # runtime it cannot yet create. Both are registered now, so neither refuses --
    # the separation is what lets a THIRD runtime be named before it works.
    assert T.resolve_axes(runtime="k8s").runtime == T.KUBERNETES
    T.require_registered(T.KUBERNETES)
    T.require_registered(T.DOCKER)
    with pytest.raises(errors.ValidationError) as caught:
        T.require_registered("nomad")
    assert "not available in this build" in str(caught.value)


def test_the_old_spellings_keep_working_and_say_what_they_are_now():
    """Permanent aliases, not a deprecation with a deadline. They cost one dict
    lookup each, and breaking a command line that is pasted into support tickets
    buys nothing."""
    from houston.services import topology as T

    a = T.resolve_axes(preset="multi-instance", params={"instances": "3"})
    assert (a.deployment, a.replicas) == (T.MULTI_INSTANCE, 3)
    assert a.params["instances"] == "3", "the original param is preserved verbatim"
    assert any("--deployment multi-instance" in h for h in a.hints)
    assert any("--replicas 3" in h for h in a.hints)

    # #3's spelling: --deployment microservices with no --runtime means Kubernetes.
    b = T.resolve_axes(deployment="microservices")
    assert b.runtime == T.KUBERNETES
    assert any("implies --runtime kubernetes" in h for h in b.hints)

    # Nothing is deprecated about the NEW spelling, so it stays quiet.
    assert T.resolve_axes(deployment="multi-instance", replicas=3).hints == []


def test_rebuilding_a_workspace_does_not_nag_about_a_spelling_nobody_typed():
    """`restore` and the GUI's recreate button rebuild a request from a record.
    Both used to pass `preset=meta.preset`, which for a multi-instance workspace
    IS the legacy spelling -- so clicking Start printed a deprecation notice at a
    user who had typed neither flag."""
    from houston.services import topology as T

    m = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official",
                           preset="multi-instance", root_url="u", host_port=3000,
                           version_source="t",
                           extra={"runtime": "docker", "deployment": "multi-instance",
                                  "instances": 3})
    kwargs = T.axes_of_meta(m)
    assert kwargs == {"runtime": "docker", "deployment": "multi-instance",
                      "preset": "default", "replicas": 3}
    assert T.resolve_axes(**kwargs).hints == [], "rebuilding is not a deprecation"

    # A workspace older than the deployment key is not lost: for those the
    # deployment WAS the preset name, which is the ambiguity the split removes.
    old = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                             mongo_tag="8.0", mongo_flavor="official",
                             preset="multi-instance", root_url="u", host_port=3000,
                             version_source="t")
    assert T.axes_of_meta(old)["deployment"] == T.MULTI_INSTANCE
    assert T.axes_of_meta(old)["runtime"] == T.DOCKER


def test_list_says_which_runtime_each_workspace_is_on(monkeypatch, tmp_path):
    """Two workspaces that differ in what every other command will do to them --
    which ones refuse, where the data lives, how to reach it -- looked identical in
    `list`, which is the one place people look first."""
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    for name, rt in (("d", topology.DOCKER), ("k", topology.KUBERNETES)):
        m = lc.runner.Metadata(name=name, project="p", rc_version="8.5.1",
                               rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                               preset="default", root_url="u", host_port=3000,
                               version_source="t")
        topology.stamp(m.extra, rt)
        lc.runner.write(name, "services: {}\n", m)

    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **kw: True)
    monkeypatch.setattr(lc.runner.queries, "project_states", lambda: {})
    monkeypatch.setattr(lc.runner.queries, "rc_status_by_project", lambda: {})
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda *a, **kw: [])
    rows = {r["name"]: r for r in lc.list_repros()}
    assert rows["d"]["runtime"] == topology.DOCKER
    assert rows["k"]["runtime"] == topology.KUBERNETES


def test_every_compose_only_command_refuses_with_a_way_forward(monkeypatch, tmp_path):
    """Six commands reached for a compose project that a Kubernetes workspace does
    not have, and answered "no configuration file provided: not found" -- which names
    nothing anyone can act on.

    A refusal that hands over the working command is worth more than an
    implementation that does not exist yet, and it can ship first. Each refusal
    names the namespace, so it is copy-pasteable rather than a hint.
    """
    from houston.services import envvars, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    cases = [
        # This list has shrunk to one. `monitor`, `backup`, `logs`, `upgrade`,
        # `stats` and reading `env` all used to be here and now have Kubernetes
        # paths of their own, each covered by its own test.
        #
        # `env --set` is the one that stays, and not for want of effort: an
        # environment variable cannot be changed inside a running container on
        # either runtime. Compose rewrites its file and recreates the service; here
        # that is a helm upgrade, which is a different operation with different
        # consequences, so it hands the command over rather than guessing.
        (lambda: envvars.set_env("k", {"A": "b"}), "helm"),
    ]
    for call, expect in cases:
        with pytest.raises(errors.ValidationError) as caught:
            call()
        msg = str(caught.value)
        assert expect in msg, msg
        assert "houston-k" in msg, f"the namespace must be named: {msg}"
        assert caught.value.exit_code == 2

    # A Compose workspace passes straight through the guard.
    plain = lc.runner.Metadata(name="d", project="houston-d", rc_version="8.5.1",
                               rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                               preset="default", root_url="u", host_port=3001,
                               version_source="t")
    topology.stamp(plain.extra, topology.DOCKER)
    lc.runner.write("d", "services: {}\n", plain)
    topology.require_compose("d", "backup")     # silent


def test_rebuilding_a_workspace_cannot_move_it_to_another_cluster():
    """`axes_of_meta` feeds `restore` and the GUI's start-a-downed-workspace button.

    Without the context those rebuild a request that sends `plan_cluster` back through
    its own four steps -- and on a box with the kind binary that is step 2, so a
    workspace living in a remote cluster would be rebuilt by BUILDING A LOCAL CLUSTER
    for it.
    """
    from houston.services import topology

    class M:
        preset = "default"
        extra = {"runtime": "kubernetes", "context": "eks-support"}

    assert topology.axes_of_meta(M()).get("context") == "eks-support"

    class Old:
        preset = "default"
        extra = {"runtime": "kubernetes"}

    assert "context" not in topology.axes_of_meta(Old()), \
        "a workspace older than --context must keep resolving exactly as it did"


def test_the_engine_gate_asks_for_the_engine_the_workspace_actually_runs_on(
        tmp_path, monkeypatch):
    """`require_docker()` ran before anything looked at the runtime.

    So on a host with no Docker — the documented adopt-an-existing-cluster setup —
    `upgrade`, `rollback`, `ready`, `logs`, `token`, `api`, `pat`, `seed`,
    `config-import` and `down` all refused a healthy Kubernetes workspace with
    "Docker isn't running". `teardown` is the sharpest: it dispatches on the runtime
    *inside* itself, under a comment about a workspace that could be created and
    never removed, and the gate three lines above defeated that dispatch.

    `backup.py`, `monitor.py` and `envvars.py` already got this right and said so in
    comments. Nobody generalised it, so each new call site started from the Compose
    assumption again.
    """
    import shutil as _shutil

    from houston.errors import DockerError, PreflightError
    from houston.services import lifecycle as lc, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # Docker is NOT available, which is the whole point.
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **k: False)

    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(_shutil, "which", lambda n: f"/usr/bin/{n}")
    lc.require_engine("k")          # must not raise: Docker is irrelevant here

    # A Compose workspace still needs Docker, or the gate would protect nothing.
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.DOCKER)
    with pytest.raises(DockerError):
        lc.require_engine("c")

    # And a Kubernetes workspace still needs kubectl — said here rather than failing
    # one layer down in a subprocess whose "command not found" names nothing.
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(_shutil, "which", lambda n: None)
    with pytest.raises(PreflightError) as caught:
        lc.require_engine("k")
    assert "kubectl" in str(caught.value)


def test_preset_and_topology_agree_on_what_the_runtimes_are_called():
    """One vocabulary for the same two things.

    `services/topology.py` is the registry every other layer reads -- repro.json,
    the CLI, the GUI and the HTTP API all say "docker"/"kubernetes". PR #3's preset
    layer said "compose"/"kubernetes" for the same pair. A second set of words for
    one concept is how `mongo_flavor` ended up being reported for a runtime that
    does not honour it, so the preset layer speaks the same words.

    `presets` is the LOWER layer and must not import `services`, so the constant is
    spelled out there and this test is what an import would have guaranteed.
    """
    from houston.services import topology

    assert presets._RUNTIME_DEFAULT == topology.DOCKER
    ldap = presets._scenario_definitions()["ldap"]
    assert set(ldap.adapters) <= topology.REGISTERED, sorted(ldap.adapters)
    assert topology.DOCKER in ldap.adapters and topology.KUBERNETES in ldap.adapters


def test_deployments_are_not_presets_on_this_branch():
    """PR #3 modelled `microservices` as a PRESET that implies Kubernetes, so the
    runtime was inferred from the scenario name. This branch models it as a
    DEPLOYMENT under an explicit `--runtime`, which is why `resolve_selection`,
    `DEPLOYMENT_PRESETS` and the alias map were left behind rather than taken.

    Keeping both would have given two answers to "what runs where" -- and the one
    that infers would have quietly won, because it needs no flag.
    """
    from houston.services import topology

    assert not hasattr(presets, "resolve_selection")
    assert not hasattr(presets, "DEPLOYMENT_PRESETS")
    # Deployments live in exactly one place.
    assert topology.MICROSERVICES in topology.DEPLOYMENTS[topology.KUBERNETES]
    assert topology.MULTI_INSTANCE in topology.DEPLOYMENTS[topology.DOCKER]
    assert "microservices" not in presets.scenario_names()


def test_prune_asks_kubernetes_whether_a_kubernetes_workspace_is_down(
        monkeypatch, tmp_path):
    """"Is it down" was answered by Docker for every workspace, on both runtimes.

    `prunable` listed a repro when no compose PROJECT was running. A Kubernetes
    workspace never has one, so a healthy workspace serving traffic was reported as
    down and offered up for deletion -- `prune` announces "deletes N down repro(s)
    incl. data" with a live one counted among them. It could not then remove it
    either: the loop ran `docker compose down` against a workspace with no compose
    file, which always failed.

    Found by an audit that went looking for why an orphaned namespace was still
    running with no state file anywhere to manage it.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def workspace(name, runtime, port):
        m = lc.runner.Metadata(name=name, project=f"houston-{name}",
                               rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
                               mongo_flavor="official", preset="default",
                               root_url=f"http://localhost:{port}", host_port=port,
                               version_source="t")
        if runtime == topology.KUBERNETES:
            topology.stamp(m.extra, runtime)
        ws = lc.runner.workspace(name)
        ws.mkdir(parents=True, exist_ok=True)
        (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    workspace("live-k8s", topology.KUBERNETES, 3000)
    workspace("gone-k8s", topology.KUBERNETES, 3001)
    workspace("down-docker", topology.DOCKER, 3002)

    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.runner.queries, "project_states", lambda: set())
    monkeypatch.setattr(lc.auditsvc, "actor", lambda: "")
    monkeypatch.setattr(lc.ownership, "may_destroy", lambda n, a: (True, ""))
    # The live one still has its Rocket.Chat workload; the other does not.
    monkeypatch.setattr(k8s.status, "workload_exists",
                        lambda name, *, context: name == "live-k8s")

    targets = lc.prunable()
    assert "live-k8s" not in targets, (
        "a RUNNING Kubernetes workspace was offered for deletion, because the "
        "question was put to Docker and it has no compose project either way")
    assert "gone-k8s" in targets, "a Kubernetes workspace with no workload IS down"
    assert "down-docker" in targets, "and Compose must keep behaving as before"


def test_prune_removes_a_kubernetes_workspace_through_kubernetes(
        monkeypatch, tmp_path):
    """And having listed one, it has to be able to remove it.

    The loop called `runner.down` -- `docker compose down` -- for every target, so a
    Kubernetes workspace was warned about and skipped every time, leaving its
    namespace and PersistentVolumeClaim on the cluster indefinitely.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    monkeypatch.setattr(lc.pruning, "prunable", lambda: ["k"])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.runner.engine, "down",
                        lambda *a, **kw: pytest.fail(
                            "it reached for `docker compose down` on Kubernetes"))
    deleted: list[tuple] = []
    monkeypatch.setattr(k8s.namespace, "delete_namespace",
                        lambda name, *, context, volumes, emit=None:
                            deleted.append((name, volumes)) or True)

    out = lc.prune(confirm=True)
    assert deleted == [("k", True)], "the namespace and its PVC must actually go"
    assert out["removed"] == ["k"]
    assert not lc.runner.workspace("k").exists(), "and the local record with it"


def test_reading_env_answers_from_the_container_on_kubernetes(monkeypatch, tmp_path):
    """`env` with no --set went through three states, and this pins the last one.

    First it raised a bare FileNotFoundError naming
    `repros/<n>/docker-compose.yml` -- a path, with no statement of what was wrong.
    That escaped the ReproError contract, so `serve` answered 500 to a request that
    is merely unsupported while `logs` and `stats` answered cleanly on the same
    workspace. Then it refused cleanly. Now it answers.

    From the RUNNING CONTAINER, which is not a translation of the Compose behaviour
    but better than it: the chart contributes variables houston never set, so
    neither the helm values nor any generated document would show them.

    `env --set` still refuses -- an environment variable cannot be changed inside a
    running container on either runtime, and here that means a helm upgrade.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import envvars, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    assert not (ws / "docker-compose.yml").exists(), \
        "the absence of a compose file is the condition under test"

    monkeypatch.setattr(k8s.status, "container_env", lambda name, *, context: {
        "ROOT_URL": "http://localhost:3010", "ADMIN_PASS": "admin123"})
    out = envvars.current("k")
    keys = {r["key"]: r["value"] for r in out["env"]}
    assert keys["ROOT_URL"] == "http://localhost:3010"
    assert keys["ADMIN_PASS"] != "admin123", "credentials masked, as on Compose"

    # The WRITE path still refuses, and names the command that does the job.
    with pytest.raises(errors.ValidationError) as caught:
        envvars.set_env("k", {"A": "b"})
    assert "helm" in str(caught.value)
    assert caught.value.http_status == 400


def test_doctor_fails_when_a_kubernetes_workspace_exists_but_the_tools_do_not(
        monkeypatch, tmp_path):
    """The same finding, opposite severity. A workspace that cannot be reached OR
    TORN DOWN is a real fault -- and the teardown half is what makes it urgent,
    because the resources keep running."""
    from houston.services import doctor, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "services: {}\n", m)

    monkeypatch.setattr(k8s.tools, "which", lambda _t: "")
    report = doctor.run_checks()
    kube = [r for r in report["checks"] if "Kubernetes workspace(s) exist" in r["message"]]
    assert len(kube) == 1, [r["message"] for r in report["checks"]]
    assert kube[0]["status"] == "fail"
    assert "torn down" in kube[0]["message"]
    assert report["verdict"] == "fail"


def test_down_removes_a_kubernetes_workspace_instead_of_asking_docker(monkeypatch, tmp_path):
    """The gap the first successful CLI create exposed: `down` reached for a compose
    project that is not there and answered "no configuration file provided: not
    found", leaving a workspace that could be CREATED and never removed.

    The dispatch sits BELOW the confirmation, the ownership gate and the audit
    record, which are about whose data is being destroyed and do not depend on the
    runtime -- duplicating them per runtime is how one loses a check the other keeps.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.6.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3010,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.runner.engine, "down",
                        lambda *a, **k: pytest.fail("it asked docker compose"))
    called = {}
    monkeypatch.setattr(k8s.namespace, "delete_namespace",
                        lambda name, **kw: called.update(name=name, **kw) or True)

    out = lc.teardown("k", volumes=False)
    assert out["runtime"] == topology.KUBERNETES
    assert called == {"name": "k", "context": k8s.CONTEXT, "volumes": False,
                      "emit": lc.null_emit}, called

    # And --volumes still needs the confirmation, which is shared rather than
    # reimplemented per runtime.
    with pytest.raises(errors.ValidationError):
        lc.teardown("k", volumes=True, confirm=False)


def test_up_uses_the_runtime_the_workspace_already_has(monkeypatch, tmp_path):
    """`houston up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker
    and ran `docker compose up` against a workspace with no compose file:

        'rc8-5-1' already exists - bringing it back up.
        no configuration file provided: not found
        error: `docker compose up` failed

    `--runtime` says what to CREATE. What already exists is a fact, not a preference.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    took: list = []
    monkeypatch.setattr(lc.create_k8s, "_create_kubernetes",
                        lambda req, emit=None, **_kw: took.append(req.runtime) or {})
    monkeypatch.setattr(lc.runner.engine, "up",
                        lambda *a, **kw: pytest.fail("it ran docker compose up"))
    # No --runtime at all, exactly as the failing command had it.
    lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="k"))
    assert took == [topology.KUBERNETES], took


def test_up_brings_a_downed_kubernetes_workspace_back_instead_of_refusing(
        monkeypatch, tmp_path):
    """Two messages in the same tool contradicting each other about one workspace:

        $ houston down --name rc8-5-1
        ✓ down (the namespace and its PersistentVolumeClaim are kept).
          bring it back: houston up --version <same> --name rc8-5-1
        $ houston up -v 8.5.1 --runtime kubernetes
        error: 'rc8-5-1' already exists. `down` first, or pass --force

    Compose reuses an existing workspace. So does this now -- the namespace and PVC
    surviving a plain `down` is exactly what makes bringing it back meaningful.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s.context, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s.reachability, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s.namespace, "assert_namespace_available", lambda *a, **kw: None)
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    monkeypatch.setattr(k8s.workspace, "create_workspace", lambda **kw: {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})

    out = lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                            runtime=topology.KUBERNETES))
    assert out["reused"] is True, "it refused a workspace `down` said to bring back"


def test_a_workspace_comes_back_on_the_port_it_left_on(monkeypatch, tmp_path):
    """`up` after `down` allocated a fresh port, so a workspace created on :3382
    came back on :3000 -- every bookmark, every curl pasted into a ticket, and the
    URL the user had just been shown all pointed at nothing.

    An explicit --port still wins; otherwise the recorded one does, and only a
    genuinely new workspace allocates.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s.context, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s.reachability, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s.namespace, "assert_namespace_available", lambda *a, **kw: None)
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3382",
                           host_port=3382, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.ports, "pick_host_port",
                        lambda *a, **kw: 3000)          # what a fresh allocation gives
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    seen: dict = {}
    monkeypatch.setattr(k8s.workspace, "create_workspace", lambda **kw: seen.update(kw) or {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})

    out = lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                            runtime=topology.KUBERNETES))
    assert seen["host_port"] == 3382, "it moved a returning workspace to a new port"
    assert out["url"] == "http://localhost:3382"

    # An explicit --port still wins, because asking for one is asking for one.
    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k", port=3999,
                                       runtime=topology.KUBERNETES))
    assert seen["host_port"] == 3999


def test_ready_asks_kubernetes_not_docker(monkeypatch, tmp_path):
    """`houston ready` answered "Rocket.Chat container is not running (check
    `logs`)" about a workspace whose pods were perfectly healthy -- `rc_state` asks
    docker whether a CONTAINER runs.

    It also re-establishes the port-forward, because `ready` is exactly the command
    someone runs when the URL is not answering, and a forward dies with its pod.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra.update({"context": k8s.CONTEXT, "namespace": "houston-k",
                    "port_forward_pid": 999999999})
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc.runner.queries, "rc_state",
                        lambda *a, **kw: pytest.fail("it asked docker"))
    monkeypatch.setattr(k8s.status, "workspace_ready", lambda *a, **kw: True)
    # `ready` now also confirms the socket answers AND that Rocket.Chat is what
    # answers -- see test_ready_confirms_the_socket_not_just_the_pid and
    # test_ready_refuses_a_url_served_by_something_that_is_not_rocketchat. Both
    # stubbed true here so this test stays about which RUNTIME is asked, which is
    # what it is named for.
    monkeypatch.setattr(k8s.forward, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda url, **kw: {"version": "8.5.1"})
    established: list = []
    monkeypatch.setattr(k8s.forward, "ensure_port_forward",
                        lambda *a, **kw: established.append(kw) or 4242)

    out = lc.wait_serving(m, lc.null_emit, timeout=30.0)
    assert out["ready"] is True
    assert established, "ready did not re-establish the forward"
    # The dead pid must be replaced in the record, or `down` later signals nothing.
    assert lc.runner.read_meta("k").extra["port_forward_pid"] == 4242


def test_tearing_down_a_kubernetes_workspace_drops_its_edge_route(monkeypatch, tmp_path):
    """The Kubernetes branch returned before the line that removes the route.

    Correct while a Kubernetes workspace could not have one. The moment `--https`
    lands it is a leak with a nasty shape: the route outlives the namespace, so the
    hostname 502s instead of 404ing -- pointing at a backend rather than at nothing
    -- and the name can never be reused by anyone else. The Compose branch twenty
    lines below has always dropped it, for exactly this reason.
    """
    from houston.services import edge as edgesvc
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="kws", project="houston-kws", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="",
                           preset="default", root_url="http://localhost:3001",
                           host_port=3001, version_source="t",
                           public_url="https://kws.houston.localhost")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["edge"] = True
    lc.runner.write("kws", "", m)
    # The route as `edge.register` would have left it.
    edgesvc.dynamic_dir().mkdir(parents=True, exist_ok=True)
    route = edgesvc.route_path("kws")
    route.write_text("# generated\n")

    monkeypatch.setattr(k8s.status, "workload_exists", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.namespace, "delete_namespace", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.operator, "remove_operator", lambda *a, **kw: False)
    monkeypatch.setattr(k8s.monitoring, "remove_monitoring", lambda *a, **kw: False)

    lc.teardown("kws", volumes=True, confirm=True)
    assert not route.exists(), \
        "the namespace went and the edge route stayed, so that name would 502 for ever"


def test_a_kubernetes_workspace_is_not_down_just_because_nobody_could_ask(monkeypatch, tmp_path):
    """`list` reported a healthy Kubernetes workspace as `down` whenever the cluster
    could not be asked -- measured at 8.3s, one PROBE_TIMEOUT, with the control plane
    paused, while the workspace was serving throughout.

    `down` is the word that invites `up --force` and `down --volumes`, so it is the
    worst of the available guesses. The Docker branch in the same function has said
    `?` for an unreachable daemon all along, and the browser already renders it.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT

    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx=None: None)
    assert lc.kubernetes_state("k", m) == "?", "an unaskable cluster is not a down one"

    # A real empty answer still means down.
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx=None: [])
    assert lc.kubernetes_state("k", m) == "down"


def test_scale_prefill_refuses_kubernetes_instead_of_asking_compose(tmp_path, monkeypatch):
    """`scaleseed` bulk-inserts through `compose_exec_capture`, so on a Kubernetes
    workspace this reached for a compose project that is not there and answered
    docker's "no configuration file provided: not found".

    Found while widening the engine gate: making `seed` runtime-aware without this
    would have traded a clear "Docker isn't running" for that.
    """
    from houston.errors import ValidationError
    from houston.services import data as datasvc, lifecycle as lc, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, actor="": "k")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    for fn in (lambda: datasvc.run_scale("k", "users=10"),
               lambda: datasvc.clear_scale("k")):
        with pytest.raises(ValidationError) as caught:
            fn()
        assert "seed" in str(caught.value).lower(), caught.value


def test_prune_does_not_need_docker_when_every_workspace_is_kubernetes(tmp_path, monkeypatch):
    """`prunable()` called `require_docker()` at the top, so `prune` was refused
    outright on a host that uses only an adopted cluster and has no Docker -- while
    the loop below it has asked Kubernetes about Kubernetes workspaces for a while.
    The gate contradicted the runtime it was gating.
    """
    from houston import runner
    from houston.services import k8s, lifecycle as lc, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = runner.Metadata(name="k", project="p", rc_version="8.5.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="http://localhost:3001", host_port=3001,
                        version_source="t")
    m.extra["runtime"] = "kubernetes"
    monkeypatch.setattr(lc.runner.record, "list_meta", lambda: [m])
    monkeypatch.setattr(topology, "of_meta", lambda meta: topology.KUBERNETES)
    monkeypatch.setattr(lc.ownership, "may_destroy", lambda *a, **k: (True, ""))
    monkeypatch.setattr(k8s.status, "workload_exists", lambda *a, **k: False)

    def _no_docker(*a, **k):
        raise AssertionError("Docker must not be required for a Kubernetes-only host")

    monkeypatch.setattr(lc.preconditions, "require_docker", _no_docker)
    assert lc.prunable() == ["k"]


def test_an_unreadable_workspace_is_not_offered_for_deletion_as_down(monkeypatch,
                                                                     tmp_path):
    """K-03. `workload_exists` returned `rc == 0 and stdout`, so a refused read was
    indistinguishable from "the workload is not there" -- and `prunable()` listed a
    LIVE workspace under "these down repros will be deleted, containers, data volumes
    and records". Measured against a workspace serving 200 at the time.
    """
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(json.dumps(asdict(m)), encoding="utf-8")

    # A refused read: non-zero exit, no stdout -- exactly what an RBAC denial or a
    # wrong context produces.
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: _completed(1, err="forbidden"))
    with pytest.raises(errors.DockerError, match="could not ask"):
        k8s.workload_exists("k", context="c")
    assert lc.prunable() == [], \
        "a workspace nobody could read was offered for deletion as `down`"
