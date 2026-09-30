"""`houston.services.lifecycle.inspect`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import lifecycle as lc
from servicehelpers import _k8s_meta, _kube_workspace


def test_repro_state_from_rc_container_status():
    # "no rocketchat container" splits on whether anything else survives.
    assert lc.repro_state("", False) == "down"
    assert lc.repro_state("", True) == "stopped"
    assert lc.repro_state("Up 2 hours (healthy)", True) == "running"
    assert lc.repro_state("Up 5 seconds (health: starting)", True) == "running"
    assert lc.repro_state("Exited (0) 2 minutes ago", True) == "stopped"
    assert lc.repro_state("Created", True) == "created"
    assert lc.repro_state("Dead", True) == "dead"
    # docker reports a paused container as "Up …(Paused)" -- it must not read as running.
    assert lc.repro_state("Up 3 days (Paused)", True) == "paused"
    # The regression: a crash-looping RC. The list used to read compose's project
    # aggregate, where the healthy Mongo's "running(1)" made this "running", while
    # detail() called it "stopped". Both had to become "restarting".
    assert lc.repro_state("Restarting (1) 5 seconds ago", True) == "restarting"


def test_repro_links():
    from houston import runner
    def meta(preset, extra=None):
        return runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                               mongo_tag="8.0", mongo_flavor="official", preset=preset,
                               root_url="http://localhost:8300", host_port=8300,
                               version_source="x", extra=extra or {})
    # s3_minio -> console + api URLs surfaced
    s3 = {l["label"]: l["url"] for l in lc.repro_links(meta("s3_minio"))}
    assert s3["Rocket.Chat"] == "http://localhost:8300"
    assert "MinIO console" in s3 and "MinIO API" in s3
    # oidc -> keycloak
    oidc = {l["label"]: l["url"] for l in lc.repro_links(meta("oidc"))}
    assert "Keycloak" in oidc and oidc["Keycloak"].startswith("http://localhost:")
    # monitoring adds Grafana + Prometheus
    mon = {l["label"] for l in lc.repro_links(meta("default", {"monitoring": True}))}
    assert {"Grafana", "Prometheus"} <= mon
    # multi-instance adds instance URLs
    mi = {l["label"] for l in lc.repro_links(meta("multi-instance", {"instances": 3}))}
    assert {"instance 1", "instance 2", "instance 3"} <= mi


def test_uptime_health_parsing():
    assert lc._uptime_health("Up 2 hours (healthy)") == ("2 hours", "healthy")
    assert lc._uptime_health("Up 47 minutes") == ("47 minutes", "")
    assert lc._uptime_health("Exited (0) 5 minutes ago") == ("", "")
    assert lc._uptime_health("") == ("", "")


def test_a_transitional_health_is_reported_without_dockers_string_prefix():
    """Docker spells the transitional state "health: starting" inside the Status
    string, and bare "healthy"/"unhealthy" for the settled ones.

    Taken verbatim the panel rendered "Health: health: starting". The prefix belongs
    to the string format, not to the value.
    """
    assert lc._uptime_health("Up 4 seconds (health: starting)") == ("4 seconds", "starting")
    assert lc._uptime_health("Up 2 hours (healthy)") == ("2 hours", "healthy")
    assert lc._uptime_health("Up 5 minutes (unhealthy)") == ("5 minutes", "unhealthy")
    # No healthcheck at all, and a stopped container, are both "no health".
    assert lc._uptime_health("Up 3 minutes") == ("3 minutes", "")
    assert lc._uptime_health("Exited (0) 1 minute ago") == ("", "")


def test_detail_gives_a_kubernetes_workspace_its_links_and_its_pods(
        monkeypatch, tmp_path):
    """The Kubernetes branch of detail() returned before it built either.

    `links` are not compose-shaped and never were: a preset's UI answers on the SAME
    host port under both runtimes, because k8s.scenario_ui_forwards forwards it to the
    same number deliberately. Leaving them out meant phpLDAPadmin, Keycloak, MinIO,
    Mailpit and Grafana were unreachable from the GUI on Kubernetes while the CLI
    printed every one of them.

    `containers` was empty on purpose, and the tab reads an empty list as "no
    containers — this repro is down" — under a workspace that was running, with no
    way at all to see an ImagePullBackOff from a browser.
    """
    from houston.services import k8s

    _kube_workspace(tmp_path, monkeypatch, preset="ldap")
    monkeypatch.setattr(lc.inspect, "kubernetes_state", lambda name, meta: "running")
    monkeypatch.setattr(k8s.status, "pod_rows", lambda name, **kw: [
        {"service": "rocketchat-rocketchat-1", "state": "running",
         "status": "1/1 ready", "health": "healthy", "restarts": 0,
         "started": "2026-08-18T10:00:00Z"},
        {"service": "rocketchat-mongodb-0", "state": "pending",
         "status": "ImagePullBackOff", "health": "", "restarts": 0, "started": ""}])

    d = lc.detail("k")
    labels = {link["label"] for link in d["links"]}
    assert "Rocket.Chat" in labels
    assert "phpLDAPadmin" in labels, "the scenario's own UI, on the same port as Compose"
    assert [c["service"] for c in d["containers"]] == [
        "rocketchat-rocketchat-1", "rocketchat-mongodb-0"]
    assert "ImagePullBackOff" in d["containers"][1]["status"]
    # microservices, because that is what this runtime DEFAULTS to and the record
    # names no deployment -- see topology.DEPLOYMENTS.
    assert d["runtime"] == "kubernetes" and d["deployment"] == "microservices"
    assert d["namespace"] == "houston-k"
    assert d["uptime"], "an uptime, from the earliest running pod"


def test_detail_of_a_kubernetes_workspace_survives_docker_being_down(
        monkeypatch, tmp_path):
    """detail() asked docker first, and its docker-unavailable branch reads the
    workspace's COMPOSE FILE. A Kubernetes workspace has none, so a box whose daemon
    was merely asleep answered the panel with a FileNotFoundError -- a 500 -- for a
    workspace running perfectly well in the cluster. The runtime is asked first now.
    """
    from houston.services import k8s

    _kube_workspace(tmp_path, monkeypatch, preset="default")
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc.inspect, "kubernetes_state", lambda name, meta: "running")
    monkeypatch.setattr(k8s.status, "pod_rows", lambda name, **kw: [])

    d = lc.detail("k")          # must not raise
    assert d["state"] == "running", "docker's absence says nothing about a cluster"
    assert d["links"], "and the links are still there"


def test_a_workspace_made_before_groups_existed_still_renders_as_groups():
    """The grouped notes were built at create time and written into `repro.json`, so
    they only ever reached workspaces created after the release that added them. Every
    existing workspace kept the flat eleven-bullet dump in `info` and in the GUI panel
    for life, and the only way to see the new shape was to destroy the workspace and
    build another -- which for a repro of a customer's issue is the one thing you
    cannot do.

    Notes are a pure function of the record (namespace, context, release, bind host,
    preset), so they are derived on every read. This record is exactly what an older
    release wrote: a flat list and no groups at all.
    """
    m = _k8s_meta()
    m.extra["notes"] = [
        "microservices on kind-houston-local - about 9 pods, namespace houston-old",
        "reachable on this box at http://localhost:3000",
    ]
    s = lc._summary(m)
    titles = [g["title"] for g in s["note_groups"]]
    assert titles[:2] == ["Kubernetes", "MongoDB"]
    # The three steps read in the order somebody has to perform them.
    assert titles[2:5] == ["1 · Point kubectl and helm at this cluster",
                           "2 · Open the way in",
                           "3 · Look at what is inside"], titles
    # The facts that were welded into a sentence are rows now, for this record too.
    rows = dict((k, v) for k, v in s["note_groups"][0]["rows"])
    assert rows == {"Cluster": "kind-houston-local", "Namespace": "houston-old",
                    "Arrangement": "microservices", "Pods": "about 9"}
    # And the flat list the CLI prints is the derived one, not the sentence above.
    assert s["notes"] == lc.flatten_notes(s["note_groups"])
    assert not any("about 9 pods, namespace" in n for n in s["notes"])


def test_the_detail_payload_carries_the_workspace_password(tmp_path, monkeypatch):
    """What both front-ends read. The GUI's detail panel renders `login` with a copy
    button and the create dialog's result box shows the same dict, so a generated
    password reaches a browser-only operator through this one key -- which is also
    the payload-shape trap `_fake_detail` exists for."""
    from houston import config, tls as tlsmod  # noqa: F401
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="d", project="houston-d", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3001", host_port=3001, version_source="live",
        admin_password="s3cret-generated-value")
    assert lc._summary(meta)["login"] == {"user": "admin",
                                          "password": "s3cret-generated-value"}
    # And an older record still reports the password its Rocket.Chat really runs.
    meta.admin_password = ""
    assert lc._summary(meta)["login"]["password"] == "admin123"
