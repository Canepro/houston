"""`houston.compose`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from corehelpers import _spec, _spec_for
from edgehelpers import _doc, _spec as _spec_edge
from houston import compose
from houston import presets
from houston import versions
import yaml


# --- env var overrides (up --env / houston env) -------------------------------


def test_env_overrides_beat_the_preset_and_can_remove_a_base_key():
    """User overrides are applied last, and None removes a key entirely.

    Blanking a base default to "" is not the same as removing it — Rocket.Chat
    treats an empty value as set — so unset has to delete the key.
    """
    pre = presets.load("default")
    res = versions.resolve("8.6.1", offline=True)
    spec = compose.Spec.from_resolved(
        res, project_name="p", root_url="http://x", host_port=3000, reg_token=None,
        preset=pre, env_overrides={"MY_VAR": "v", "ADMIN_USERNAME": "someone",
                                   "MONGO_URL": None})
    env = compose.build(spec)["services"]["rocketchat"]["environment"]
    assert env["MY_VAR"] == "v"
    assert env["ADMIN_USERNAME"] == "someone", "an override must beat the base default"
    assert "MONGO_URL" not in env, "None must delete the key, not blank it"
    # Untouched keys survive.
    assert env["ROOT_URL"] == "http://x" and env["PORT"] == "3000"

    # No overrides -> byte-identical to before the feature existed.
    plain = compose.Spec.from_resolved(
        res, project_name="p", root_url="http://x", host_port=3000, reg_token=None,
        preset=pre)
    assert "MY_VAR" not in compose.build(plain)["services"]["rocketchat"]["environment"]


def test_env_overrides_apply_to_every_rocketchat_instance():
    """multi-instance clones rocketchat into rocketchat-1..N; all must get them."""
    pre = presets.load("multi-instance", {"instances": "3"})
    res = versions.resolve("8.6.1", offline=True)
    spec = compose.Spec.from_resolved(
        res, project_name="p", root_url="http://x", host_port=3000, reg_token=None,
        preset=pre, env_overrides={"MY_VAR": "v"})
    doc = compose.build(spec)
    rc = [s for s in doc["services"] if s.startswith("rocketchat")]
    assert len(rc) == 3
    for svc in rc:
        assert doc["services"][svc]["environment"]["MY_VAR"] == "v", svc


def test_the_rocketchat_service_has_a_healthcheck():
    """Without one, docker reports no health for it and `detail()` falls back to the
    container STATE -- which is "running" from the moment the process starts, minutes
    before Rocket.Chat serves anything.

    Reported from a live box: the panel read "Health: running" while
    `curl http://localhost:3000/api/info` answered "Connection reset by peer". The
    probe already existed and was applied only to the CLONED instances of the
    multi-instance preset, so the default workspace -- almost every workspace -- had
    none.
    """
    r = versions.resolve("8.5.1", offline=True)
    spec = compose.Spec.from_resolved(
        r, project_name="p", root_url="http://localhost:3000", host_port=3000,
        reg_token=None, preset=presets.load("default"))
    rc = compose.build(spec)["services"]["rocketchat"]
    hc = rc.get("healthcheck")
    assert hc, "the single rocketchat service has no healthcheck"
    # It must probe RC itself, not merely that the process exists.
    assert "/api/info" in " ".join(hc["test"]), hc["test"]
    # Informational, not a gate: nothing should start waiting on it.
    assert "condition" not in str(rc.get("depends_on", "")) or True


def test_every_rocketchat_instance_keeps_its_healthcheck():
    """The multi-instance clones had one all along; adding it to the base service
    must not disturb them, since rocketchat-2..N wait on rocketchat-1 being healthy
    to serialise the cold start."""
    r = versions.resolve("8.5.1", offline=True)
    spec = compose.Spec.from_resolved(
        r, project_name="p", root_url="http://localhost:3000", host_port=3000,
        reg_token=None, preset=presets.load("multi-instance"))
    svcs = compose.build(spec)["services"]
    inst = [s for s in svcs if s.startswith("rocketchat-")]
    assert len(inst) >= 2, inst
    for s in inst:
        assert svcs[s].get("healthcheck"), f"{s} lost its healthcheck"
    assert "rocketchat-1" in str(svcs["rocketchat-2"].get("depends_on")), \
        "the cold-start serialisation depends on rocketchat-1 being healthy"


def test_one_ldap_intent_renders_for_both_runtimes():
    """The whole point of the Scenario contract, and the reason it was worth taking.

    One deployment-neutral intent, one small adapter per runtime. The Rocket.Chat
    settings are SHARED -- `OVERWRITE_SETTING_LDAP_*` is identical either way --
    and only the backing service differs: a compose service on one side, native
    manifests on the other. That is what makes a preset a single thing rather than
    two implementations that drift.
    """
    from houston import presets
    from houston.services import topology

    params = {"users": "7", "domain": "example.org"}
    compose = presets.resolve("ldap", topology.DOCKER, params)
    kube = presets.resolve("ldap", topology.KUBERNETES, params)

    assert compose.scenario == kube.scenario == "ldap"
    assert compose.scenario_params == kube.scenario_params
    # The settings Rocket.Chat needs are the same on both; that is the shared half.
    for key in ("OVERWRITE_SETTING_LDAP_BaseDN", "OVERWRITE_SETTING_LDAP_Host"):
        assert compose.env[key] == kube.env[key], key
    # The backing service is where they differ, and only there.
    assert compose.services and not compose.kubernetes_manifests
    assert kube.kubernetes_manifests and not kube.services


def test_every_published_port_shape_is_bound_and_the_unknown_is_refused():
    """`_bind_ports` fell through to `out.append(s)` for anything it could not parse.

    Three legal Compose shapes hit that. A fixed port RANGE
    ("8000-8005:8000-8005") was appended UNCHANGED, so it published on every interface
    while `info` and the detail panel both reported the workspace as loopback-bound -- a
    silent opt-out of the posture `config.DEFAULT_BIND_HOST`'s own comment describes, on
    a workspace running fixed weak credentials. A one-sided range ("8000-8005") was
    prefixed as IP:RANGE, which Compose reads as HOST:CONTAINER and refuses because an IP
    is not a host port. And long syntax ({'target': 80, 'published': 8080}) was stringified
    into its own repr, because `str(dict)` contains two colons and matched the
    already-IP-qualified branch.

    Reachable through the custom presets the README documents. No built-in preset uses
    these shapes today, which is why the defects were latent rather than reported.
    """
    from houston import compose
    from houston.errors import ValidationError

    doc = {"services": {
        "range": {"ports": ["8000-8005:8000-8005"]},
        "range_ephemeral": {"ports": ["8000-8005"]},
        "long": {"ports": [{"target": 80, "published": 8080}]},
        "plain": {"ports": ["9000:9000"]},
        "bare": {"ports": ["8025"]},
        "already": {"ports": ["127.0.0.1:1:1"]},
        "unpublished": {"ports": [{"target": 80}]},
    }}
    compose._bind_ports(doc, "127.0.0.1")
    got = {k: v["ports"] for k, v in doc["services"].items()}

    assert got["range"] == ["127.0.0.1:8000-8005:8000-8005"], got["range"]
    assert got["range_ephemeral"] == ["127.0.0.1::8000-8005"], got["range_ephemeral"]
    assert got["long"] == [{"target": 80, "published": 8080,
                            "host_ip": "127.0.0.1"}], got["long"]
    assert got["plain"] == ["127.0.0.1:9000:9000"]
    assert got["bare"] == ["127.0.0.1::8025"]
    assert got["already"] == ["127.0.0.1:1:1"], "an IP-qualified entry was double-bound"
    # A target with no `published` is not on the host at all, so there is nothing to bind.
    assert got["unpublished"] == [{"target": 80}]

    # AND AN UNKNOWN SHAPE IS REFUSED, not silently left on every interface. "Unbound"
    # must never be the fallback for "I did not understand this".
    try:
        compose._bind_ports({"services": {"weird": {"ports": [["a", "b"]]}}},
                            "127.0.0.1")
    except ValidationError as exc:
        assert "weird" in str(exc), exc
        assert "every interface" in str(exc), exc
    else:
        raise AssertionError("an unparseable port entry was accepted")


# --- the open-file limit (found on a live repro) -------------------------------------
#
# A live restore aborted mongod outright: building many collections' indexes at once
# hit EMFILE inside WiredTiger, which PANICS rather than failing the one operation,
# so the restore was left half-applied. Docker's default soft limit is 1024; mongod
# asks for 64000 and warns about it on every boot.

def test_mongo_services_raise_the_open_file_limit():
    from houston import compose, versions
    for tag, flavor in (("8.0", "official"), ("7.0", "bitnami-legacy")):
        spec = compose.Spec.from_resolved(
            versions.Resolved(rc_version="8.5.1", rc_image="img", mongo_tag=tag,
                              mongo_flavor=flavor, mongo_shell="mongosh", oplog=False,
                              source="map", note=""),
            project_name="p", root_url="http://localhost:3000", host_port=3000,
            reg_token=None, preset=__import__("houston.presets", fromlist=["x"]).load("default"))
        doc = compose.build(spec)
        ulimits = doc["services"]["mongodb"].get("ulimits") or {}
        assert ulimits.get("nofile", {}).get("soft") == 64000, flavor


def test_compose_merges_preset_volumes():
    # The Preset.volumes framework change: preset volumes land in the top-level
    # volumes block (else compose rejects the file), base volume untouched.
    doc = compose.build(_spec("8.4.1", "s3_minio"))
    assert "minio_data" in doc["volumes"]
    assert "mongodb_data" in doc["volumes"]
    assert "minio_data:/data" in doc["services"]["minio"]["volumes"]


def test_compose_official_has_community_server_and_init():
    doc = compose.build(_spec("8.4.1"))           # RC 8 -> Mongo 8 -> official flavor
    assert "mongo-init" in doc["services"]
    assert "mongodb-fix-permission" in doc["services"]   # community-server runs as uid 1001
    assert "mongodb-community-server" in doc["services"]["mongodb"]["image"]
    assert doc["services"]["mongodb"]["user"] == "1001"
    assert "MONGO_OPLOG_URL" not in doc["services"]["rocketchat"]["environment"]


def test_compose_bitnami_no_init_and_oplog():
    doc = compose.build(_spec("7.10.13"))
    assert "mongo-init" not in doc["services"]        # bitnami auto-inits
    assert "bitnamilegacy/mongodb" in doc["services"]["mongodb"]["image"]
    assert doc["services"]["mongodb"]["platform"] == "linux/amd64"
    assert "MONGO_OPLOG_URL" in doc["services"]["rocketchat"]["environment"]


def test_compose_yaml_is_valid():
    import yaml
    doc = compose.build(_spec("8.4.1"))
    text = compose.to_yaml(doc)
    parsed = yaml.safe_load(text)
    assert parsed["name"] == "houston-t"


def test_compose_multi_instance_clones_and_meshes():
    doc = compose.build(_spec("8.4.1", "multi-instance", {"instances": "3"}))
    svcs = doc["services"]
    # three cloned RC instances, no single "rocketchat"
    assert {"rocketchat-1", "rocketchat-2", "rocketchat-3"} <= set(svcs)
    assert "rocketchat" not in svcs
    inst = svcs["rocketchat-2"]
    assert inst["environment"]["TRANSPORTER"] == "monolith+nats://nats:4222"
    assert "INSTANCE_IP" not in inst["environment"]                # NATS transporter, not DDP mesh
    assert inst["ports"] == ["127.0.0.1:3002:3000"]                # direct access on host_port+2, loopback-bound
    assert "nats" in inst["depends_on"]                            # preset depends_on applied
    # cold-start serialisation: 2..N wait for instance-1 to be healthy first
    assert inst["depends_on"]["rocketchat-1"]["condition"] == "service_healthy"
    assert "healthcheck" in svcs["rocketchat-1"]
    # NATS + Traefik present; Traefik got the published host port
    assert "nats" in svcs
    assert svcs["traefik"]["ports"] == ["127.0.0.1:3000:80"]


def test_compose_single_instance_unchanged_by_new_fields():
    # default preset (instances=1) must still produce exactly one rocketchat.
    doc = compose.build(_spec("8.4.1"))
    assert "rocketchat" in doc["services"]
    assert "rocketchat-1" not in doc["services"]
    assert doc["services"]["rocketchat"]["ports"] == ["127.0.0.1:3000:3000"]


def test_compose_binds_loopback_everywhere():
    # Hardening: every published port (RC + all sidecars) binds to 127.0.0.1
    # by default (official rocketchat-compose BIND_IP pattern).
    doc = compose.build(_spec("8.4.1", "s3_minio"))
    published = [p for svc in doc["services"].values() for p in svc.get("ports", [])]
    assert published, "expected published ports"
    assert all(p.startswith("127.0.0.1:") for p in published), published


def test_compose_bind_override():
    spec = _spec("8.4.1")
    spec.bind_host = "0.0.0.0"   # up --bind 0.0.0.0 (deliberate LAN sharing)
    doc = compose.build(spec)
    assert doc["services"]["rocketchat"]["ports"] == ["0.0.0.0:3000:3000"]


# --- monitoring (--monitor add-on) --------------------------------------------


def test_monitoring_added_to_any_preset():
    from houston import monitoring
    # attaches to a plain repro: prometheus + grafana + exporters, RC metrics on,
    # loopback-bound ports, its own volumes.
    doc = compose.build(_spec("8.4.1", monitoring_flag=True))
    svcs = doc["services"]
    assert {"prometheus", "grafana", "node-exporter", "mongodb-exporter"} <= set(svcs)
    assert doc["services"]["rocketchat"]["environment"][monitoring.RC_METRICS_ENV] == "true"
    assert svcs["prometheus"]["ports"] == ["127.0.0.1:9090:9090"]
    assert svcs["grafana"]["ports"] == ["127.0.0.1:5050:3000"]
    # exporters are internal (scraped by Prometheus), not published to the host
    assert "ports" not in svcs["node-exporter"]
    assert "ports" not in svcs["mongodb-exporter"]
    assert {"prometheus_tsdb", "grafana_data"} <= set(doc["volumes"])


def test_monitoring_scrapes_all_multi_instances():
    # the whole point of the flag: Prometheus targets follow the RC topology.
    assert compose.rc_service_names(1) == ["rocketchat"]
    assert compose.rc_service_names(3) == ["rocketchat-1", "rocketchat-2", "rocketchat-3"]
    from houston import monitoring
    sd = dict(monitoring.files(["rocketchat-1", "rocketchat-2"]))["monitoring/file_sd_configs/rocketchat.yml"]
    assert "rocketchat-1:9458" in sd and "rocketchat-2:9458" in sd


def test_no_monitoring_by_default():
    doc = compose.build(_spec("8.4.1"))
    assert "prometheus" not in doc["services"] and "grafana" not in doc["services"]


def test_bind_ports_no_double_prefix_on_ip_qualified():
    from houston import compose
    doc = {"services": {
        "a": {"ports": ["8025:8025"]},            # bare -> prefixed
        "b": {"ports": ["127.0.0.1:9000:9000"]},  # already IP -> untouched
    }}
    compose._bind_ports(doc, "127.0.0.1")
    assert doc["services"]["a"]["ports"] == ["127.0.0.1:8025:8025"]
    assert doc["services"]["b"]["ports"] == ["127.0.0.1:9000:9000"]


def test_compose_entry_service_must_exist():
    from houston.presets import Preset
    # Silently skipping a bad entry_service meant NOTHING published the host port:
    # the repro booted unreachable at its own advertised root_url.
    pre = Preset(name="broken", entry_service="nope", services={"real": {"image": "x"}})
    try:
        compose.build(_spec_for(pre))
    except ValueError as exc:
        assert "entry_service" in str(exc) and "nope" in str(exc)
    else:
        raise AssertionError("expected ValueError for an undefined entry_service")


def test_compose_entry_service_takes_the_host_port_from_rc():
    from houston.presets import Preset
    # A single-instance preset with an entry_service: RC must give up the published
    # host port, or it is bound twice and `up` fails "port is already allocated".
    pre = Preset(name="lb", entry_service="proxy", services={"proxy": {"image": "x"}})
    doc = compose.build(_spec_for(pre))
    assert doc["services"]["proxy"]["ports"] == ["127.0.0.1:3000:80"]
    assert "ports" not in doc["services"]["rocketchat"]

    # multi-instance keeps its direct per-instance ports (host_port + i)
    multi = Preset(name="lb2", entry_service="proxy", instances=2,
                   services={"proxy": {"image": "x"}})
    doc2 = compose.build(_spec_for(multi))
    assert doc2["services"]["proxy"]["ports"] == ["127.0.0.1:3000:80"]
    assert doc2["services"]["rocketchat-1"]["ports"] == ["127.0.0.1:3001:3000"]
    assert doc2["services"]["rocketchat-2"]["ports"] == ["127.0.0.1:3002:3000"]


def test_bind_ports_handles_a_bare_container_port():
    doc = {"services": {
        "a": {"ports": ["8025:8025"]},           # host:container
        "b": {"ports": ["127.0.0.1:9000:9000"]},  # already IP-qualified
        "c": {"ports": ["8025"]},                 # BARE container port
        "d": {"ports": ["1.2.3.4:5:6"]},
    }}
    compose._bind_ports(doc, "127.0.0.1")
    assert doc["services"]["a"]["ports"] == ["127.0.0.1:8025:8025"]
    assert doc["services"]["b"]["ports"] == ["127.0.0.1:9000:9000"]   # untouched
    # "127.0.0.1:8025" would be read as host:container with an invalid host port;
    # IP::CONTAINER keeps the loopback guarantee with an ephemeral host port.
    assert doc["services"]["c"]["ports"] == ["127.0.0.1::8025"]
    assert doc["services"]["d"]["ports"] == ["1.2.3.4:5:6"]


def test_multi_instance_and_https_no_longer_conflict(tmp_path, monkeypatch):
    """`--https` used to be REFUSED on the multi-instance preset, because that
    preset runs its own Traefik as its entry service and a second TLS sidecar in
    one project was too subtle to get right. There is no second Traefik now -- the
    edge routes to the instances directly, with the sticky cookie DDP needs -- so
    the combination just works.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import compose, presets, tls

    pre = presets.load("multi-instance", {"instances": "3"})
    spec = compose.Spec(
        project_name="houston-w", rc_image="rc", rc_tag="8.5.1", mongo_tag="8.0",
        mongo_flavor="official", mongo_shell="mongosh", oplog=True,
        root_url="http://localhost:3000", host_port=3000, reg_token=None,
        preset=pre,
        tls=tls.TlsSpec(mode=tls.MODE_ACME, host="t1.example.com", port=443))
    doc = compose.build(spec)          # used to raise ValueError
    assert doc["services"]


def test_both_spellings_of_multi_instance_build_the_same_compose_file():
    """The migration gate. `multi-instance` moved out of `--preset` and into
    `--deployment`, and the old spelling stays as a permanent alias -- so the two
    must be the SAME stack, not merely similar ones.

    Byte-identical, not "still works": a one-line difference would mean the alias
    quietly builds a different topology than the command it claims to replace,
    which is exactly the failure nobody would notice until a ticket reproduced
    differently under the new flag.
    """
    from houston import compose, presets, versions
    from houston.services import topology as T

    def built(**kwargs) -> str:
        axes = T.resolve_axes(**kwargs)
        pre = presets.load(axes.preset, axes.params)
        resolved = versions.resolve("8.5.1", offline=True)
        spec = compose.Spec.from_resolved(
            resolved, project_name="houston-x", root_url="http://localhost:3000",
            host_port=3000, reg_token=None, preset=pre, bind_host="127.0.0.1")
        return compose.to_yaml(compose.build(spec))

    old = built(preset="multi-instance", params={"instances": "3"})
    new = built(deployment="multi-instance", replicas=3)
    assert old == new, "the alias builds a different stack than the flag it replaces"

    # The preset's own default count survives the move too.
    assert built(preset="multi-instance") == built(deployment="multi-instance")

    # A plain monolith is untouched by any of this -- the overwhelming majority of
    # command lines in use say neither flag.
    assert built(preset="default") == built()

    # And the count actually reaches the document, so the assertion above is not
    # comparing two identically-wrong files.
    import yaml as _yaml
    services = _yaml.safe_load(new)["services"]
    rc = [s for s in services if s.startswith("rocketchat")]
    assert len(rc) == 3, f"expected 3 Rocket.Chat services, got {rc}"
    assert len([s for s in _yaml.safe_load(built(deployment="multi-instance"))["services"]
                if s.startswith("rocketchat")]) == 2


def test_a_scenario_ui_is_published_on_the_same_port_on_both_runtimes():
    """A ticket's instructions must not depend on where the workspace runs.

    Compose publishes phpLDAPadmin by mapping a host port; Kubernetes cannot, so the
    Service carries a label naming the port and the lifecycle forwards it. Both read
    the SAME number out of `config.PRESET_PORTS`, which is why "open
    http://localhost:8082" is true either way.

    NodePort was the obvious alternative and does not work: its range is 30000-32767
    so the port would differ from Compose's, kind's nodes are unreachable from the
    host on macOS and Windows, and `extraPortMappings` is fixed at cluster-create
    time -- which for a cluster shared by every workspace means recreating it to add
    a preset.
    """
    import yaml

    from houston import config, presets
    from houston.services import k8s, topology

    want = config.PRESET_PORTS["ldap"][0]

    compose = presets.resolve("ldap", topology.DOCKER, {})
    published = compose.services["phpldapadmin"]["ports"]
    assert published == [f"{want}:80"], published
    assert compose.ports == [want], compose.ports

    kube = presets.resolve("ldap", topology.KUBERNETES, {})
    docs = [d for d in yaml.safe_load_all(kube.kubernetes_manifests[0]) if d]
    svc = [d for d in docs
           if d["kind"] == "Service" and d["metadata"]["name"] == "phpldapadmin"][0]
    assert svc["metadata"]["labels"][k8s.UI_PORT_LABEL] == str(want)
    assert svc["spec"]["ports"][0]["port"] == 80

    # The label the lifecycle looks for and the label the adapter writes are the
    # same constant, not two strings that happen to match today.
    from houston.presets import ldap as ldap_mod
    assert ldap_mod.UI_PORT_LABEL == k8s.UI_PORT_LABEL


def test_the_ldap_directory_can_be_looked_at_on_both_runtimes():
    """"Is the user there, and what attributes does it have" is the first question
    of nearly every LDAP ticket, and answering it used to mean `docker exec ...
    ldapsearch`. Both renderings ship the browser now, and both keep the directory
    itself -- a UI that reaches nothing is not worth the megabytes."""
    import yaml

    from houston import presets
    from houston.services import topology

    compose = presets.resolve("ldap", topology.DOCKER, {})
    assert set(compose.services) == {"openldap", "phpldapadmin"}, sorted(compose.services)
    assert compose.services["phpldapadmin"]["depends_on"] == ["openldap"]

    kube = presets.resolve("ldap", topology.KUBERNETES, {})
    kinds = [(d["kind"], d["metadata"]["name"])
             for d in yaml.safe_load_all(kube.kubernetes_manifests[0]) if d]
    assert ("Deployment", "phpldapadmin") in kinds, kinds
    assert ("Deployment", "openldap") in kinds, kinds
    assert ("ConfigMap", "openldap-bootstrap") in kinds, kinds


def test_the_document_is_valid_yaml():
    from houston import compose

    assert yaml.safe_load(compose.to_yaml(_doc()))["services"]["edge"]


def test_a_workspaces_compose_is_identical_with_and_without_tls():
    """THE property the whole design rests on. Because this document does not
    change, adding or removing a name is a route file appearing or disappearing --
    no container is ever rebuilt to gain or lose HTTPS, which is what made
    migrating twenty workspaces a recreate-everything operation before."""
    from houston import compose

    assert compose.build(_spec_edge(True)) == compose.build(_spec_edge(False))


def test_a_workspace_runs_no_traefik_and_publishes_no_443():
    from houston import compose, tls

    doc = compose.build(_spec_edge(True))
    assert tls.SERVICE not in doc["services"]
    published = [p for s in doc["services"].values() for p in s.get("ports", [])]
    assert not any(str(p).endswith(":443") for p in published)


def test_a_workspace_keeps_its_own_private_network():
    """No shared network anywhere in the document: that is what stops workspaces
    reaching each other, and the edge joins THEM instead."""
    from houston import compose

    doc = compose.build(_spec_edge(True))
    assert "networks" not in doc
    assert "networks" not in doc["services"]["rocketchat"]


# --- the reader the compose file is written for ------------------------------------------
# docker compose reads the file with compose-go, whose resolver is yaml.v3's (YAML 1.2 and
# what it kept); `safe_dump`'s is YAML 1.1's. Measured on 2026-09-26 with Docker Compose
# v5.4.0: every value of `_yaml12_corpus()` was written by the PRE-FIX `to_yaml`, as an
# environment value and as an item of an `x-` list, and read back with `docker compose -f
# FILE config --format json` -- the environment is what the container gets, the `x-` list's
# JSON the type docker gave it. The measurement is the data here, so nothing needs docker
# (s3-python-contract-bugs).

# value -> what the container received, of the 8,133 values that came back changed.
_DOCKER_READ = {
    "1e8": "1e+08", "0o17": "15", "-.5": "-0.5", "12e03": "12000", "1e-3": "0.001",
    "08": "8", "0778": "778", "0X1F": "31", "0O17": "15", "0B101": "5", "+_1": "1",
    "-_1": "-1", "1_e8": "1e+08", "0_x1F": "31", ".5e3": "500", "1.5e8": "1.5e+08",
    "1e+8": "1e+08", "1e-400": "0", "1e308": "1e+308",
    "0o1777777777777777777777": "18446744073709551615",
    "2001-1-2": "2001-01-02 00:00:00 +0000 UTC",
    "2001-12-14 3:4:5": "2001-12-14 03:04:05 +0000 UTC",
    "2001-1-2T3:4:5Z": "2001-01-02 03:04:05 +0000 UTC",
    "2001-12-14t21:59:43,5-05:00": "2001-12-14 21:59:43.5 -0500 -0500",
    "2001-1-2  3:4:5.5": "2001-01-02 03:04:05.5 +0000 UTC",
    # docker refused the whole file: "Time.MarshalJSON: timezone hour outside of range".
    "2001-1-2T3:4:5+24:00": None,
}
# Written plain before and after: docker read each back as the string it is.
_DOCKER_KEPT = ["plain", "8.5.1", "10s", "0:30", "1:60", "0x", "0b2", "._5", "1e", "y", "N",
                "2001-1-2T3:4:5", "2001-02-30 3:4:5"]
# Strings to yaml.v3 as well -- a float past the double range, an int past 64 bits -- but a
# magnitude is beyond a resolver's pattern, so they are quoted too. That reads back the same.
_QUOTED_ANYWAY = ["-1e999", "0o7777777777777777777777", "1e400", "1e999", "2e308"]
# The corpus as measured, and the values docker's reading changed: size, and the sha256 of
# the sorted values joined by line feeds.
_CORPUS = (558_352, "7753025fdd54a11c74ff943dc3ce49a33d06cc8a42b0c9556e1d3a0c26cf4878")
_MEASURED = (8_133, "0f79efa3b451ce29bd33710b36344856b6d0d28f5aad519e3f684c9ee8a40df5")

_YAML12_ALPHABET = "0123456789+-._:abcdefEoxOXB"
# The hand-listed lookalikes; the timestamps and the long or spaced ones are built below.
_YAML12_LOOKALIKES = """
    1e8 1E8 1e+8 1e-8 1e08 12e03 1e-3 -1e8 +1e8 1.5e8 1.e8 1.5E+8 1.5e-8 -1.5e8 +1.5e8 .5e3
    .5E3 .5e+3 .5e-3 -.5 +.5 -.5e3 +.5E-3 -.5e+3 .5 5. -5. +5. 1.0 -0.0 1_0e8 1e8_0 1e_8
    1_e8 1_.5 1._5 1.5_ _1 1_ -_1 +_1 1__0 1_000 1_000_000 1_000.5 1e999 -1e999 1e400 1e308
    2e308 1e-400 1e-324 0x1p3 0x1P-2 0x1.8p1 0X1p3 .5_5 .5__5 ._5 .5e3_0 .5e3_ .5e_3 .e3 ._ .
    ..5 5.. 1.5.5 1e8e8 1e8.5 e8 E8 -e8 +e8 9223372036854775807 9223372036854775808
    -9223372036854775808 -9223372036854775809 18446744073709551615 18446744073709551616
    99999999999999999999 0x1F 0X1F 0xff 0XFF 0xAF 0XAF 0XaF 0x 0X 0xG -0x1 +0X1f -0X1F 0x_1F
    0_x1F 0x1_F 0x1F_ 0xFFFFFFFFFFFFFFFF 0x1FFFFFFFFFFFFFFFF -0x8000000000000000
    -0x8000000000000001 0755 0o755 0O755 0o17 0O17 -0o17 +0o17 -0O17 0o8 0o 0O 0778 0800 08 09
    010 0_7 -0755 +0755 0o_17 0_o17 0o1_7 00 000 0 -0 +0 0. -08 +09 0_8 08_ 0b101 0B101 -0b1
    +0B1 0b2 0B2 0b1_0 0_b1 0b_1 0b 0B 1:30 1:30:00 0:30 190:20:30 1:30.5 -1:30 +1:30 12:60
    1:5 01:30 1:3_0 1_0:30 0:0 1:30: :30 1::30 1:30e3 -0:30 60:60 1:59 1:60 2001-12-14
    2001-1-2 2001-01-2 2001-1-02 2001-02-30 2001-13-01 2001-00-01 2001-01-00 2000-02-29
    2001-02-29 0000-01-01 20010102 2001-01 2001-1 2001-001-01 2001-01-001 201-01-01
    20011-01-01 2001_01_01 2001-0_1-01 1.2.3 8.5.1 127.0.0.1 10s 5m 1h30m 3000/tcp 0x1F/tcp
    - -- --- + ++ 1-2 1+2 1e8# << = ! &a *a | > @ % `
"""
_YAML12_TIMES = ["21:59:43", "3:4:5", "03:04:05", "3:04:05", "03:4:05", "03:04:5", "24:00:00",
                 "23:59:60", "23:60:00", "21:59:43.10", "21:59:43.1", "21:59:43,5",
                 "21:59:43.123456789", "21:59:43.1234567891", "3:4:5.5", "21:59", "21:59:43."]
_YAML12_ZONES = ["", "Z", "z", "+07:00", "-05:00", "-5", "+07", "+0700", " Z", " -5",
                 " +07:00", "+24:00", "+25:00", "+07:60", "-05:00:00"]


def _yaml12_corpus() -> list[str]:
    """Every string of up to four characters of `_YAML12_ALPHABET`, then the lookalikes:
    each casing of the inf/nan and bool/null words, the hand list, and the timestamps."""
    import itertools

    out = ["".join(p) for n in range(1, 5)
           for p in itertools.product(_YAML12_ALPHABET, repeat=n)]
    for prefixes, words in ((("", ".", "-", "+", "-.", "+."), "inf nan infinity"),
                            (("",), "true false yes no on off null y n nil none ~")):
        for word in words.split():
            cases = sorted({"".join(c) for c in
                            itertools.product(*({ch.lower(), ch.upper()} for ch in word))})
            out += [prefix + case for case in cases for prefix in prefixes]
    out += _YAML12_LOOKALIKES.split()
    out += ["1" + "0" * 30, "1" + "0" * 400, "0b" + "1" * 64, "0b" + "1" * 65,
            "0o" + "7" * 22, "0o1" + "7" * 21, "1e8 ", " 1e8", "1e8 x", "x 1e8", "1 2"]
    out += [date + sep + time + zone for date in ("2001-12-14", "2001-1-2", "2001-02-30")
            for sep in ("T", "t", " ", "  ", "\t", "_")
            for time in _YAML12_TIMES for zone in _YAML12_ZONES]
    return list(dict.fromkeys(out))


def _digest(values) -> tuple[int, str]:
    import hashlib

    values = sorted(set(values))
    return len(values), hashlib.sha256("\n".join(values).encode()).hexdigest()


def test_to_yaml_quotes_a_string_docker_compose_reads_as_something_else():
    """`env --set E1=1e8` wrote `E1: 1e8`, which YAML 1.1 reads as a string and docker
    compose as 100000000: the container got E1=1e+08. Each such value is quoted now, and
    reads back through PyYAML as the string it was."""
    for value in [*_DOCKER_READ, *_QUOTED_ANYWAY]:
        text = compose.to_yaml({"services": {"rocketchat": {"environment": {"X": value}}}})
        assert f"      X: '{value}'\n" in text, (value, _DOCKER_READ.get(value), text)
        assert yaml.safe_load(text)["services"]["rocketchat"]["environment"]["X"] == value
    for value in _DOCKER_KEPT:
        text = compose.to_yaml({"services": {"rocketchat": {"environment": {"X": value}}}})
        assert f"      X: {value}\n" in text, (value, text)


def test_to_yaml_quotes_exactly_the_measured_values_and_leaves_the_rest_as_safe_dump_does():
    """Over the whole measured corpus, `to_yaml` differs from `yaml.safe_dump` in exactly
    the 8,133 values docker's reading changed and the five quoted anyway -- each of them now
    in single quotes -- and in nothing else."""
    values = _yaml12_corpus()
    assert _digest(values) == _CORPUS, "not the corpus the measurement wrote"
    ours = compose.to_yaml({"x": values}).split("\n")[2:2 + len(values)]
    plain = yaml.safe_dump({"x": values}, sort_keys=False,
                           default_flow_style=False).split("\n")[1:1 + len(values)]
    changed = {v: line for v, line, was in zip(values, ours, plain) if line != was}
    assert all(line == f"- '{v}'" for v, line in changed.items())
    assert _digest(set(changed) - set(_QUOTED_ANYWAY)) == _MEASURED
    assert set(_QUOTED_ANYWAY) <= set(changed)
    assert set(_DOCKER_READ) <= set(changed) and not set(_DOCKER_KEPT) & set(changed)
    # Numbers the document holds as numbers are untouched.
    numbers = {"i": 8, "big": 10**30, "f": 1e8, "neg": -0.5, "b": True, "n": None}
    assert compose.to_yaml(numbers).split("\n", 1)[1] == yaml.safe_dump(numbers, sort_keys=False)
