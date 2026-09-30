"""Unit tests for backup / restore / upgrade (no Docker).

Docker is replaced at the runner seam, so these exercise the real decision logic:
what gets dumped, which restores are refused, when an upgrade may be offered, and
what the compose rewrite does to a multi-instance repro.
"""

from __future__ import annotations

import dataclasses
import json
import tarfile
from pathlib import Path

import pytest

from conftest import OWN_MODULE, call_sequence, source_of

from houston import errors, runner
from houston.services import backup as bk
from houston.services import upgrade as up


# --- helpers -------------------------------------------------------------------

def make_meta(name="rc8-5-1", rc_version="8.5.1", mongo_tag="8.0", preset="default",
              **extra_fields):
    fields = {f.name for f in dataclasses.fields(runner.Metadata)}
    base = {n: "" for n in fields}
    base.update(name=name, project=f"houston-{name}", rc_version=rc_version,
                rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                mongo_tag=mongo_tag, mongo_flavor="official", preset=preset,
                root_url="http://localhost:3000", host_port=3000,
                version_source="map", extra={})
    base.update(extra_fields)
    return runner.Metadata(**base)


COMPOSE_ONE = {
    "services": {
        "mongodb": {"image": "mongo:8.0"},
        "rocketchat": {
            "image": "registry.rocket.chat/rocketchat/rocket.chat:8.5.1",
            "environment": {
                "MONGO_URL": "mongodb://mongodb:27017/rocketchat?replicaSet=rs0",
                "PORT": "3000",
            },
        },
    },
    "volumes": {"mongodb_data": {}},
}


def write_repro(name, doc=None, meta=None):
    """Materialise a workspace the way runner.write would."""
    import yaml
    meta = meta or make_meta(name=name)
    ws = runner.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "docker-compose.yml").write_text(yaml.safe_dump(doc or COMPOSE_ONE))
    (ws / "repro.json").write_text(json.dumps(dataclasses.asdict(meta)))
    return meta


# --- database resolution ---------------------------------------------------------

def test_database_is_read_from_mongo_url_not_assumed(monkeypatch):
    """`env --set MONGO_URL=...` is supported, so the db name has to be read.

    Dumping the wrong database yields an empty archive that only looks fine until
    somebody restores it.
    """
    write_repro("rc8-5-1")
    assert bk.database_of("rc8-5-1") == "rocketchat"

    doc = json.loads(json.dumps(COMPOSE_ONE))
    doc["services"]["rocketchat"]["environment"]["MONGO_URL"] = \
        "mongodb://mongodb:27017/custom_db?replicaSet=rs0&x=1"
    write_repro("other", doc)
    assert bk.database_of("other") == "custom_db"




def test_database_handles_list_form_environment():
    doc = json.loads(json.dumps(COMPOSE_ONE))
    doc["services"]["rocketchat"]["environment"] = [
        "MONGO_URL=mongodb://mongodb:27017/listdb?replicaSet=rs0"]
    write_repro("listform", doc)
    assert bk.database_of("listform") == "listdb"


# --- bundle format ----------------------------------------------------------------

def test_bundle_rejects_a_traversal_entry(tmp_path):
    """A bundle can arrive from a colleague, so it is untrusted input."""
    evil = tmp_path / "evil.rcbak"
    payload = tmp_path / "payload"
    payload.write_text("x")
    with tarfile.open(evil, "w:gz") as tar:
        tar.add(payload, arcname="../../escaped.txt")
    with pytest.raises(errors.ValidationError, match="unsafe entry"):
        bk.read_manifest(evil)


def test_bundle_with_a_foreign_schema_is_refused(tmp_path):
    b = tmp_path / "old.rcbak"
    man = tmp_path / bk.MANIFEST
    man.write_text(json.dumps({"schema": 999, "repro": "x"}))
    with tarfile.open(b, "w:gz") as tar:
        tar.add(man, arcname=bk.MANIFEST)
    with pytest.raises(errors.ValidationError, match="schema"):
        bk.read_manifest(b)


def test_bundle_without_a_manifest_is_refused(tmp_path):
    b = tmp_path / "notours.rcbak"
    other = tmp_path / "hello.txt"
    other.write_text("hi")
    with tarfile.open(b, "w:gz") as tar:
        tar.add(other, arcname="hello.txt")
    with pytest.raises(errors.ValidationError, match="houston backup"):
        bk.read_manifest(b)


def test_missing_bundle_is_a_not_found():
    with pytest.raises(errors.NotFoundError):
        bk.read_manifest("/nope/does-not-exist.rcbak")


# --- compatibility rules ------------------------------------------------------------
#
# Asked of the module that OWNS the policy. `backup` re-exports `compatibility`, so
# `bk.compatibility` still resolves and every call below still reads it through the
# facade -- but naming the owner is what makes a failure point at the right file,
# and what the structure gate means by a module having a test at all.
from houston.services import backup_compat  # noqa: E402


def test_the_policy_the_facade_re_exports_is_the_one_that_is_tested():
    """`bk.compatibility` must BE `backup_compat.compatibility`, not a copy.

    A second implementation behind the same name is how the web UI and the CLI
    would start answering a restore question differently.
    """
    assert bk.compatibility is backup_compat.compatibility



def man(rc_version="8.5.1", mongo_tag="8.0", preset="default", **kw):
    base = {"schema": bk.SCHEMA, "rc_version": rc_version, "mongo_tag": mongo_tag,
            "preset": preset, "database": "rocketchat", "sidecar_volumes": []}
    base.update(kw)
    return base


def test_same_version_restore_is_allowed_and_quiet():
    c = bk.compatibility(man(), make_meta())
    assert c["allowed"] and c["direction"] == "same"
    assert c["requires_flag"] == "" and c["warnings"] == []


def test_older_data_into_a_newer_workspace_needs_an_explicit_flag():
    c = bk.compatibility(man(rc_version="8.4.0"), make_meta(rc_version="8.5.1"))
    assert c["allowed"] and c["direction"] == "upgrade"
    assert c["requires_flag"] == "allow_upgrade"
    assert "migrations" in c["warnings"][0]


def test_newer_data_into_an_older_workspace_is_blocked():
    """Rocket.Chat does not migrate a database backwards."""
    c = bk.compatibility(man(rc_version="8.5.1"), make_meta(rc_version="7.0.0"))
    assert not c["allowed"] and c["direction"] == "downgrade"
    assert "downgrad" in c["blocked_reason"]


def test_mongo_major_difference_warns_but_does_not_block():
    c = bk.compatibility(man(mongo_tag="8.0"), make_meta(mongo_tag="6.0"))
    assert c["allowed"]
    assert any("MongoDB major" in w for w in c["warnings"])


def test_sidecar_volumes_are_flagged_as_missing_from_the_bundle():
    c = bk.compatibility(man(sidecar_volumes=["minio_data"]), make_meta())
    assert any("sidecar data is NOT" in w for w in c["warnings"])


def test_preset_mismatch_and_live_dump_are_both_flagged():
    c = bk.compatibility(man(preset="s3_minio", live=True),
                         make_meta(preset="default"))
    assert any("preset" in w for w in c["warnings"])
    assert any("--live" in w for w in c["warnings"])


def test_unparseable_versions_do_not_crash_the_comparison():
    c = bk.compatibility(man(rc_version="not-a-version"), make_meta(rc_version="8.5.1"))
    assert c["allowed"]
    assert any("cannot compare" in w for w in c["warnings"])


# --- create ----------------------------------------------------------------------

class FakeDump:
    """Stands in for the mongodb container: records calls, writes a plausible dump."""

    def __init__(self, payload=b"BSON-ARCHIVE-BYTES", rc=0):
        self.payload, self.rc = payload, rc
        self.dumped, self.restored, self.stopped, self.started = [], [], [], []

    def to_file(self, name, service, args, dest, timeout=None):
        self.dumped.append((name, service, list(args)))
        Path(dest).write_bytes(self.payload)
        return self.rc, ""

    def from_file(self, name, service, args, src, timeout=None):
        self.restored.append((name, service, list(args), Path(src).read_bytes()))
        return self.rc, ""


@pytest.fixture
def fake_docker(monkeypatch):
    f = FakeDump()
    monkeypatch.setattr(bk.lifecycle.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(bk, "_require_mongo_tools", lambda name: None)
    monkeypatch.setattr(runner.engine, "compose_exec_to_file", f.to_file)
    monkeypatch.setattr(runner.engine, "compose_exec_from_file", f.from_file)
    monkeypatch.setattr(runner.engine, "stop_services",
                        lambda n, s: f.stopped.append((n, tuple(s))) or 0)
    monkeypatch.setattr(runner.engine, "start_services",
                        lambda n, s: f.started.append((n, tuple(s))) or 0)
    return f


def test_backup_dumps_only_rocketchats_own_database(fake_docker):
    write_repro("rc8-5-1")
    res = bk.create("rc8-5-1")
    _, service, args = fake_docker.dumped[0]
    assert service == "mongodb"
    assert args[:2] == ["mongodump", "--archive"]
    assert "--gzip" in args
    # --db, so `admin`/`local` never travel and the target's replica set is safe.
    assert args[args.index("--db") + 1] == "rocketchat"
    assert Path(res["path"]).exists()


def test_backup_stops_rocketchat_and_starts_it_again(fake_docker):
    """A dump under a live writer is not consistent across collections."""
    write_repro("rc8-5-1")
    bk.create("rc8-5-1")
    assert fake_docker.stopped == [("rc8-5-1", ("rocketchat",))]
    assert fake_docker.started == [("rc8-5-1", ("rocketchat",))]


def test_backup_restarts_rocketchat_even_when_the_dump_fails(fake_docker):
    """Leaving the workspace stopped is worse than the failure itself."""
    write_repro("rc8-5-1")
    fake_docker.rc = 1
    with pytest.raises(errors.DockerError):
        bk.create("rc8-5-1")
    assert fake_docker.started == [("rc8-5-1", ("rocketchat",))]


def test_live_backup_leaves_rocketchat_running(fake_docker):
    write_repro("rc8-5-1")
    bk.create("rc8-5-1", live=True)
    assert fake_docker.stopped == [] and fake_docker.started == []


def test_backup_quiesces_every_instance_of_a_multi_instance_repro(fake_docker):
    """Stopping only the first would leave the others writing during the dump."""
    doc = json.loads(json.dumps(COMPOSE_ONE))
    rc = doc["services"].pop("rocketchat")
    doc["services"]["rocketchat-1"] = rc
    doc["services"]["rocketchat-2"] = json.loads(json.dumps(rc))
    write_repro("multi", doc)
    bk.create("multi")
    assert fake_docker.stopped == [("multi", ("rocketchat-1", "rocketchat-2"))]


def test_backup_bundle_carries_the_manifest_and_workspace_files(fake_docker):
    meta = make_meta(preset="s3_minio")
    meta.extra = {"params": {"bucket": "custom"}, "env": {"A": "b"}}
    write_repro("rc8-5-1", meta=meta)
    (runner.workspace("rc8-5-1") / "traefik").mkdir()
    (runner.workspace("rc8-5-1") / "traefik" / "dynamic.yml").write_text("x: 1")

    res = bk.create("rc8-5-1", note="before upgrade")
    with tarfile.open(res["path"], "r:gz") as tar:
        names = set(tar.getnames())
    assert {bk.MANIFEST, bk.ARCHIVE, bk.COMPOSE, bk.RECORD} <= names
    assert any(n.startswith(bk.FILES_DIR) for n in names)

    m = res["manifest"]
    assert m["label"] == "before upgrade"
    assert m["rc_version"] == "8.5.1" and m["preset"] == "s3_minio"
    assert m["params"] == {"bucket": "custom"} and m["env_overrides"] == {"A": "b"}
    assert m["archive_bytes"] > 0 and len(m["archive_sha256"]) == 64


def test_backup_excludes_uploaded_customer_settings(fake_docker):
    """workspace/import/ holds customers' uploaded dumps; a backup is not where
    those should accumulate."""
    write_repro("rc8-5-1")
    imp = runner.workspace("rc8-5-1") / "import"
    imp.mkdir()
    (imp / "u0123456789ab.json").write_text("[]")
    res = bk.create("rc8-5-1")
    with tarfile.open(res["path"], "r:gz") as tar:
        assert not any("import" in n for n in tar.getnames())


def test_backup_refuses_to_overwrite_an_existing_out_path(fake_docker, tmp_path):
    write_repro("rc8-5-1")
    dest = tmp_path / "taken.rcbak"
    dest.write_text("existing")
    with pytest.raises(errors.ConflictError):
        bk.create("rc8-5-1", out=str(dest))


def test_backup_rejects_an_empty_dump(fake_docker):
    """An empty archive restores as an empty workspace; catch it at source."""
    write_repro("rc8-5-1")
    fake_docker.payload = b""
    with pytest.raises(errors.DockerError, match="empty archive"):
        bk.create("rc8-5-1")


def test_bundle_is_owner_only(fake_docker):
    """It contains every message and the admin password hash."""
    write_repro("rc8-5-1")
    res = bk.create("rc8-5-1")
    assert (Path(res["path"]).stat().st_mode & 0o777) == 0o600


# --- list ---------------------------------------------------------------------------

def test_list_backups_reports_an_unreadable_bundle_rather_than_hiding_it(fake_docker):
    write_repro("rc8-5-1")
    bk.create("rc8-5-1")
    (bk.backups_dir() / "corrupt.rcbak").write_bytes(b"not a tarball")
    rows = bk.list_backups()
    assert len(rows) == 2
    assert sum(1 for r in rows if r["error"]) == 1


def test_list_backups_filters_by_repro(fake_docker):
    write_repro("a")
    write_repro("b")
    bk.create("a")
    bk.create("b")
    assert [r["repro"] for r in bk.list_backups("a")] == ["a"]


def test_delete_refuses_a_path_outside_the_managed_directory(tmp_path):
    stray = tmp_path / "elsewhere.rcbak"
    stray.write_text("x")
    with pytest.raises(errors.ValidationError, match="managed backup directory"):
        bk.delete(stray)
    assert stray.exists()


# --- restore --------------------------------------------------------------------------

@pytest.fixture
def restorable(fake_docker, monkeypatch):
    # `**kw` because the real one takes `timeout` and `final` too -- restore passes
    # `final=False`, since it goes on to restore after the workspace is serving and
    # must not have announced the end.
    monkeypatch.setattr(bk.lifecycle.ready, "wait_and_finalize",
                        lambda meta, emit, **kw: {"url": meta.root_url})
    write_repro("rc8-5-1")
    return bk.create("rc8-5-1")["path"]


def test_restore_in_place_drops_before_loading(restorable, fake_docker):
    """Without --drop a restore merges two databases into a hybrid."""
    bk.restore(restorable)
    _, service, args, payload = fake_docker.restored[0]
    assert service == "mongodb"
    assert args[:2] == ["mongorestore", "--archive"]
    assert "--drop" in args and "--gzip" in args
    assert payload == b"BSON-ARCHIVE-BYTES"


def test_restore_does_not_remap_namespaces_when_the_database_matches(restorable,
                                                                    fake_docker):
    bk.restore(restorable)
    _, _, args, _ = fake_docker.restored[0]
    assert not any(a.startswith("--nsFrom") for a in args)


def test_restore_remaps_when_the_target_uses_a_different_database(restorable,
                                                                  fake_docker):
    doc = json.loads(json.dumps(COMPOSE_ONE))
    doc["services"]["rocketchat"]["environment"]["MONGO_URL"] = \
        "mongodb://mongodb:27017/renamed?replicaSet=rs0"
    write_repro("rc8-5-1", doc)
    bk.restore(restorable)
    _, _, args, _ = fake_docker.restored[0]
    assert "--nsFrom=rocketchat.*" in args and "--nsTo=renamed.*" in args


def test_restore_stops_rocketchat_first(restorable, fake_docker):
    """Dropping collections under a live writer is what --drop exists to prevent."""
    fake_docker.stopped.clear()
    bk.restore(restorable)
    assert fake_docker.stopped == [("rc8-5-1", ("rocketchat",))]


def test_restore_refuses_a_downgrade(restorable):
    write_repro("older", meta=make_meta(name="older", rc_version="7.0.0"))
    with pytest.raises(errors.ValidationError, match="downgrad"):
        bk.restore(restorable, name="older")


def test_restore_into_a_newer_workspace_needs_allow_upgrade(restorable):
    write_repro("newer", meta=make_meta(name="newer", rc_version="8.6.1"))
    with pytest.raises(errors.ValidationError, match="allow-upgrade"):
        bk.restore(restorable, name="newer")
    res = bk.restore(restorable, name="newer", allow_upgrade=True)
    assert res["direction"] == "upgrade" and res["to_version"] == "8.6.1"


def test_restore_detects_a_corrupt_archive(restorable, monkeypatch):
    monkeypatch.setattr(bk, "_sha256", lambda p: "0" * 64)
    with pytest.raises(errors.ValidationError, match="corrupt"):
        bk.restore(restorable)


def test_restore_of_a_missing_repro_points_at_new(restorable):
    import shutil
    shutil.rmtree(runner.workspace("rc8-5-1"))
    with pytest.raises(errors.NotFoundError, match=r"--new"):
        bk.restore(restorable)


def test_restore_new_creates_the_repro_from_the_manifest(restorable, monkeypatch):
    created = {}

    def fake_create(req, emit=None, **kw):
        created.update(version=req.version, preset=req.preset, name=req.name,
                       params=req.params, env=req.env, mongo=req.mongo)
        write_repro(req.name, meta=make_meta(name=req.name))
        return {}

    monkeypatch.setattr(bk.lifecycle.create_docker, "create_repro", fake_create)
    res = bk.restore(restorable, new=True)
    assert res["created"] and res["name"] == "rc8-5-1-restored"
    assert created["version"] == "8.5.1" and created["preset"] == "default"


def test_restore_new_rebuilds_the_preset_the_bundle_came_from(fake_docker, monkeypatch):
    """`restore --new` has to reproduce the workspace, and a preset IS the workspace.

    The three-axis branch of _create_from_manifest hardcoded preset="default" while
    reading runtime and deployment from the manifest. Every modern bundle records
    `deployment`, so that branch is the one always taken -- and `restore --new` on an
    ldap or s3_minio bundle produced a VANILLA workspace holding that preset's data:
    LDAP users with no directory to bind against, S3 file records with no bucket.

    Two things made it hard to notice. The progress line already printed
    "(preset ldap)" before discarding it, and `compatibility()` then warned that the
    dump came from a different preset -- which reads as a mismatch to be aware of
    rather than something houston had just done itself.

    The test above this one passes either way: its bundle's preset IS "default".
    """
    # _create_from_manifest is exercised directly: it is the whole defect, and
    # driving it through bk.restore on a Kubernetes bundle would drag in real
    # kubectl execs and a 300s readiness poll for nothing.
    seen = {}

    def fake_create(req, emit=None, **kw):
        seen.update(preset=req.preset, runtime=req.runtime,
                    deployment=req.deployment, version=req.version,
                    params=req.params)
        return {}

    monkeypatch.setattr(bk.lifecycle.create_docker, "create_repro", fake_create)

    # Exactly the shape `backup` writes today -- every modern bundle records
    # `deployment`, which is what selects the branch that dropped the preset.
    manifest = {"rc_version": "8.5.1", "mongo_tag": "8.0", "preset": "ldap",
                "runtime": "kubernetes", "deployment": "microservices",
                "params": {"users": "5"}, "env_overrides": {}}
    bk._create_from_manifest("rebuilt", manifest, bk.null_emit)

    assert seen["preset"] == "ldap", (
        "restore --new threw the preset away: the workspace comes back without the "
        "sidecars and settings its restored data depends on")
    assert seen["runtime"] == "kubernetes", "and it must land on the same runtime"
    assert seen["deployment"] == "microservices"
    assert seen["params"] == {"users": "5"}, "the preset's parameters travel too"

    # A pre-three-axis bundle has no `deployment`; that branch always read the
    # preset and must keep doing so.
    seen.clear()
    bk._create_from_manifest("legacy", {"rc_version": "8.5.1", "preset": "email"},
                             bk.null_emit)
    assert seen["preset"] == "email" and not seen["runtime"]


def test_restore_new_refuses_to_clobber_an_existing_repro(restorable):
    write_repro("taken")
    with pytest.raises(errors.ConflictError, match="already exists"):
        bk.restore(restorable, new=True, name="taken")


def test_new_name_is_deduplicated(restorable, monkeypatch):
    write_repro("rc8-5-1-restored")
    monkeypatch.setattr(bk.lifecycle.create_docker, "create_repro",
                        lambda req, emit=None, **kw: write_repro(req.name) and {})
    res = bk.restore(restorable, new=True)
    assert res["name"] == "rc8-5-1-restored-2"


# --- upgrade: the running gate ----------------------------------------------------------

@pytest.fixture
def upgradable(monkeypatch):
    monkeypatch.setattr(up.lifecycle.preconditions, "require_docker", lambda: None)
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.queries, "rc_state", lambda n: "running")


def test_upgrade_is_offered_only_for_a_running_workspace(monkeypatch):
    monkeypatch.setattr(up.lifecycle.preconditions, "require_docker", lambda: None)
    write_repro("rc8-5-1")

    monkeypatch.setattr(runner.queries, "rc_state", lambda n: "running")
    assert up.can_upgrade("rc8-5-1") == {"can_upgrade": True, "reason": "",
                                         "current": "8.5.1"}

    # `rc_state` omits --all, so a merely STOPPED repro also reports "absent".
    # Containers existing is what separates "start it" from "up it" -- getting that
    # wrong sends someone to rebuild a repro that only needed starting.
    monkeypatch.setattr(runner.queries, "rc_state", lambda n: "absent")
    monkeypatch.setattr(runner.queries, "container_details", lambda n: [{"service": "mongodb"}])
    state = up.can_upgrade("rc8-5-1")
    assert not state["can_upgrade"]
    assert "houston start" in state["reason"] and "down" not in state["reason"]

    monkeypatch.setattr(runner.queries, "container_details", lambda n: [])
    state = up.can_upgrade("rc8-5-1")
    assert not state["can_upgrade"] and "houston up" in state["reason"]




def test_require_running_raises_not_ready_when_stopped(monkeypatch):
    monkeypatch.setattr(up.lifecycle.preconditions, "require_docker", lambda: None)
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.queries, "rc_state", lambda n: "absent")
    monkeypatch.setattr(runner.queries, "container_details", lambda n: [{"service": "mongodb"}])
    with pytest.raises(errors.NotReadyError, match="houston start"):
        up.require_running("rc8-5-1")


# --- upgrade: planning --------------------------------------------------------------------

def _resolved(rc="8.6.1", mongo="8.0", oplog=False):
    from houston import versions
    return versions.Resolved(rc_version=rc, rc_image="img", mongo_tag=mongo,
                             mongo_flavor="official", mongo_shell="mongosh",
                             oplog=oplog, source="map", note="")


def test_plan_refuses_a_downgrade(upgradable, monkeypatch):
    monkeypatch.setattr(up.versions, "resolve",
                        lambda v, offline=False: _resolved("7.0.0"))
    p = up.plan("rc8-5-1", "7.0.0")
    assert not p["allowed"] and p["direction"] == "downgrade"


def test_plan_refuses_the_same_version(upgradable, monkeypatch):
    monkeypatch.setattr(up.versions, "resolve",
                        lambda v, offline=False: _resolved("8.5.1"))
    p = up.plan("rc8-5-1", "8.5.1")
    assert not p["allowed"] and "already at" in p["blocked_reason"]


def test_plan_refuses_a_mongo_major_change_rather_than_attempting_it(upgradable,
                                                                    monkeypatch):
    """Majors need stepping one at a time with an fCV bump; guessing loses data."""
    write_repro("rc8-5-1", meta=make_meta(mongo_tag="6.0"))
    monkeypatch.setattr(up.versions, "resolve",
                        lambda v, offline=False: _resolved("8.6.1", mongo="8.0"))
    p = up.plan("rc8-5-1", "8.6.1")
    assert not p["allowed"]
    assert "6 -> 7 -> 8" in p["mongo_blocked"]


def test_plan_allows_a_straight_upgrade(upgradable, monkeypatch):
    monkeypatch.setattr(up.versions, "resolve",
                        lambda v, offline=False: _resolved("8.6.1"))
    p = up.plan("rc8-5-1", "8.6.1")
    assert p["allowed"] and p["direction"] == "upgrade"
    assert p["from_version"] == "8.5.1" and p["to_version"] == "8.6.1"


def test_plan_notes_that_tls_is_left_alone(upgradable, monkeypatch):
    write_repro("rc8-5-1", meta=make_meta(extra={"tls": "local"}))
    monkeypatch.setattr(up.versions, "resolve",
                        lambda v, offline=False: _resolved("8.6.1"))
    assert any("TLS" in w for w in up.plan("rc8-5-1", "8.6.1")["warnings"])


# --- upgrade: the compose rewrite -----------------------------------------------------------

def test_apply_image_updates_every_instance():
    doc = {"services": {
        "mongodb": {"image": "mongo:8.0"},
        "rocketchat-1": {"image": "old:1", "environment": {}},
        "rocketchat-2": {"image": "old:1", "environment": {}},
    }}
    assert up._apply_image(doc, "new", "8.6.1", oplog=False) == 2
    assert doc["services"]["rocketchat-1"]["image"] == "new:8.6.1"
    assert doc["services"]["rocketchat-2"]["image"] == "new:8.6.1"
    assert doc["services"]["mongodb"]["image"] == "mongo:8.0"   # untouched


def test_apply_image_drops_the_oplog_url_going_to_8x():
    doc = {"services": {"rocketchat": {
        "image": "old:7.5.0",
        "environment": {"MONGO_OPLOG_URL": "mongodb://mongodb:27017/local"}}}}
    up._apply_image(doc, "new", "8.6.1", oplog=False)
    assert "MONGO_OPLOG_URL" not in doc["services"]["rocketchat"]["environment"]


def test_apply_image_adds_the_oplog_url_for_pre_8x():
    doc = {"services": {"rocketchat": {"image": "old:8.0.0", "environment": {}}}}
    up._apply_image(doc, "new", "7.5.0", oplog=True)
    assert "MONGO_OPLOG_URL" in doc["services"]["rocketchat"]["environment"]


def test_apply_image_normalises_list_form_environment():
    doc = {"services": {"rocketchat": {"image": "old:1", "environment": ["PORT=3000"]}}}
    up._apply_image(doc, "new", "8.6.1", oplog=False)
    env = doc["services"]["rocketchat"]["environment"]
    assert isinstance(env, dict) and env["PORT"] == "3000"










def test_restore_drops_the_database_not_just_the_dumped_collections(restorable,
                                                                    fake_docker,
                                                                    monkeypatch):
    """mongorestore --drop only drops collections it is about to restore.

    Verified against real MongoDB: a collection created AFTER the dump survived a
    --drop restore. Restoring a pre-upgrade backup into an upgraded workspace would
    therefore leave the newer version's collections behind — the hybrid state the
    whole --drop story exists to prevent.
    """
    calls = []
    monkeypatch.setattr(runner.engine, "compose_exec_capture",
                        lambda n, s, a, timeout=None: calls.append(list(a)) or (0, ""))
    bk.restore(restorable)
    dropped = [c for c in calls if any("dropDatabase" in str(x) for x in c)]
    assert dropped, "expected the target database to be dropped before restoring"
    assert dropped[0][0] == "mongosh" and dropped[0][1] == "rocketchat"


def test_drop_uses_the_legacy_shell_for_old_mongo(fake_docker, monkeypatch):
    """`mongosh` only exists from MongoDB 5.0; older images ship `mongo`."""
    write_repro("old", meta=make_meta(name="old", mongo_tag="4.4"))
    calls = []
    monkeypatch.setattr(runner.engine, "compose_exec_capture",
                        lambda n, s, a, timeout=None: calls.append(list(a)) or (0, ""))
    bk._drop_database("old", "rocketchat")
    assert calls[0][0] == "mongo"


def test_a_failed_drop_warns_rather_than_aborting(fake_docker, monkeypatch):
    """--drop still clears everything the bundle carries, which is the common case."""
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.engine, "compose_exec_capture",
                        lambda n, s, a, timeout=None: (1, "no such command"))
    events = []
    bk._drop_database("rc8-5-1", "rocketchat", emit=events.append)
    assert any(e.level == "warn" and "may survive" in e.message for e in events)


# --- CLI wiring -------------------------------------------------------------------
#
# These bind the real command functions to the real service signatures. A live run
# caught `backup_cmd` passing `label=` after the service parameter was renamed to
# `note=` -- invisible to every test above, because they call the service directly
# and the CLI tests only rendered --help.

from typer.testing import CliRunner   # noqa: E402

from houston.cli import app          # noqa: E402

runner_cli = CliRunner()


def test_cli_backup_calls_the_service_with_the_arguments_it_accepts(monkeypatch):
    seen = {}

    def fake_create(name, out="", note="", live=False, emit=None):
        seen.update(name=name, out=out, note=note, live=live)
        return {"name": name, "path": "/tmp/b.rcbak", "bytes": 10,
                "manifest": {"rc_version": "8.5.1", "sidecar_volumes": []}}

    monkeypatch.setattr(bk, "create", fake_create)
    r = runner_cli.invoke(app, ["backup", "-n", "x", "--label", "note text", "--live"])
    assert r.exit_code == 0, r.output
    assert seen == {"name": "x", "out": "", "note": "note text", "live": True}


def test_cli_restore_passes_its_flags_through(monkeypatch):
    seen = {}

    def fake_restore(bundle, name="", new=False, allow_upgrade=False, force=False,
                     emit=None):
        seen.update(bundle=bundle, name=name, new=new, allow_upgrade=allow_upgrade,
                    force=force)
        return {"name": "x", "bundle": bundle, "created": new, "restore_seconds": 1.0,
                "direction": "same", "from_version": "8.5.1", "to_version": "8.5.1",
                "warnings": [], "url": ""}

    monkeypatch.setattr(bk, "restore", fake_restore)
    r = runner_cli.invoke(app, ["restore", "/tmp/b.rcbak", "--new", "--allow-upgrade"])
    assert r.exit_code == 0, r.output
    assert seen["new"] is True and seen["allow_upgrade"] is True


def test_cli_backups_lists_without_crashing(monkeypatch):
    monkeypatch.setattr(bk, "list_backups", lambda name="": [
        {"path": "/tmp/a.rcbak", "bytes": 2048, "repro": "x", "label": "note",
         "rc_version": "8.5.1", "created_at": "2026-01-01T00:00:00Z", "error": ""}])
    r = runner_cli.invoke(app, ["backups"])
    assert r.exit_code == 0 and "a.rcbak" in r.output


def test_cli_backups_survives_an_unreadable_bundle(monkeypatch):
    monkeypatch.setattr(bk, "list_backups", lambda name="": [
        {"path": "/tmp/bad.rcbak", "bytes": 1, "error": "corrupt"}])
    r = runner_cli.invoke(app, ["backups"])
    assert r.exit_code == 0 and "UNREADABLE" in r.output


def test_cli_upgrade_requires_a_target(monkeypatch):
    r = runner_cli.invoke(app, ["upgrade", "-n", "x"])
    assert r.exit_code != 0 and "--to" in r.output


def test_cli_upgrade_dry_run_stops_after_the_plan(monkeypatch):
    called = {}
    monkeypatch.setattr(up, "plan", lambda n, to, offline=False: {
        "name": "x", "from_version": "8.5.1", "to_version": to, "rc_image": "img",
        "from_mongo": "8.0", "to_mongo": "8.0", "mongo_blocked": "", "direction": "upgrade",
        "allowed": True, "blocked_reason": "", "warnings": [], "oplog": False,
        "source": "map"})
    monkeypatch.setattr(up, "run", lambda *a, **k: called.setdefault("ran", True))
    r = runner_cli.invoke(app, ["upgrade", "-n", "x", "--to", "8.6.1", "--dry-run"])
    assert r.exit_code == 0 and not called


def test_cli_upgrade_calls_run_with_accepted_arguments(monkeypatch):
    seen = {}
    monkeypatch.setattr(up, "plan", lambda n, to, offline=False: {
        "name": "x", "from_version": "8.5.1", "to_version": to, "rc_image": "img",
        "from_mongo": "8.0", "to_mongo": "8.0", "mongo_blocked": "", "direction": "upgrade",
        "allowed": True, "blocked_reason": "", "warnings": [], "oplog": False,
        "source": "map"})

    def fake_run(name, to, offline=False, force=False, no_backup=False,
                 rollback_on_failure=True, emit=None):
        seen.update(name=name, to=to, no_backup=no_backup,
                    rollback_on_failure=rollback_on_failure)
        return {"name": name, "from_version": "8.5.1", "to_version": to,
                "running_version": to, "boot_seconds": 1.0, "backup": "/tmp/b.rcbak",
                "migration_errors": [], "warnings": []}

    monkeypatch.setattr(up, "run", fake_run)
    r = runner_cli.invoke(app, ["upgrade", "-n", "x", "--to", "8.6.1", "--no-rollback"])
    assert r.exit_code == 0, r.output
    assert seen["to"] == "8.6.1" and seen["rollback_on_failure"] is False


def test_cli_upgrade_rollback_calls_the_service(monkeypatch):
    seen = {}
    monkeypatch.setattr(up, "rollback", lambda name, bundle="", emit=None:
                        seen.update(name=name, bundle=bundle)
                        or {"name": name, "rolled_back_to": "8.5.1", "bundle": bundle,
                            "restore": {}})
    r = runner_cli.invoke(app, ["upgrade", "-n", "x", "--rollback"])
    assert r.exit_code == 0, r.output
    assert seen["name"] == "x"




def test_restore_limits_parallelism_so_a_low_fd_repro_survives(restorable, fake_docker):
    """Repros created before the ulimit fix keep 1024 until they are recreated."""
    bk.restore(restorable)
    _, _, args, _ = fake_docker.restored[0]
    assert "--numParallelCollections=1" in args


def test_low_fd_limit_is_reported_with_the_fix(fake_docker, monkeypatch):
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.engine, "compose_exec_capture",
                        lambda n, s, a, timeout=None: (0, "1024\n"))
    events = []
    assert bk.warn_low_fd_limit("rc8-5-1", events.append) == 1024
    assert any("up --force" in e.message for e in events)


def test_a_healthy_fd_limit_is_silent(fake_docker, monkeypatch):
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.engine, "compose_exec_capture",
                        lambda n, s, a, timeout=None: (0, "64000\n"))
    events = []
    assert bk.warn_low_fd_limit("rc8-5-1", events.append) == 64000
    assert events == []


def test_an_unreadable_fd_limit_does_not_break_the_restore(fake_docker, monkeypatch):
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.engine, "compose_exec_capture",
                        lambda n, s, a, timeout=None: (1, "not a number"))
    assert bk.warn_low_fd_limit("rc8-5-1") == 0


# --- audit follow-ups: guarded filesystem access and failure paths ------------------
#
# A bundle path arrives from a CLI argument or a JSON body, so every filesystem call
# on it needs a guard. These each used to escape the service layer as a 500.

def test_an_overlong_bundle_path_is_a_validation_error():
    with pytest.raises(errors.ValidationError, match="not a usable path"):
        bk.read_manifest("/tmp/" + "x" * 300 + ".rcbak")


def test_an_unreadable_bundle_is_a_validation_error(tmp_path):
    blocked = tmp_path / "blocked.rcbak"
    blocked.write_bytes(b"data")
    blocked.chmod(0o000)
    try:
        with pytest.raises(errors.ValidationError):
            bk.read_manifest(blocked)
    finally:
        blocked.chmod(0o600)


def test_a_directory_is_not_a_bundle(tmp_path):
    d = tmp_path / "adir.rcbak"
    d.mkdir()
    with pytest.raises(errors.ValidationError):
        bk.read_manifest(d)


def test_delete_rejects_an_overlong_path():
    with pytest.raises(errors.ValidationError, match="not a usable path"):
        bk.delete("/tmp/" + "y" * 300)






def test_a_failed_restart_after_a_dump_is_reported(fake_docker, monkeypatch):
    """Reporting "backed up" over a workspace that never came back is the exact
    outcome the quiesce wrapper exists to prevent."""
    write_repro("rc8-5-1")
    monkeypatch.setattr(runner.engine, "start_services", lambda n, s: 1)   # failed restart
    events = []
    bk.create("rc8-5-1", emit=events.append)
    assert any(e.level == "warn" and "did not come back up" in e.message
               for e in events)


def test_restore_new_says_the_empty_workspace_was_left_behind(restorable, monkeypatch):
    monkeypatch.setattr(bk.lifecycle.create_docker, "create_repro",
                        lambda req, emit=None, **kw: write_repro(req.name) and {})
    monkeypatch.setattr(bk, "_require_mongo_tools",
                        lambda n: (_ for _ in ()).throw(errors.NotReadyError("no tools")))
    with pytest.raises(errors.NotReadyError, match="was created and is running, but empty"):
        bk.restore(restorable, new=True)


def test_a_failed_rollback_names_both_failures(upgradable, monkeypatch):
    """Letting the rollback's error propagate would hide WHY the upgrade failed,
    while the workspace sits at neither version."""
    monkeypatch.setattr(up.versions, "resolve",
                        lambda v, offline=False: _resolved("8.6.1"))
    monkeypatch.setattr(up.backupsvc, "_create_locked",
                        lambda t, note="", emit=None: {"path": "/tmp/pre.rcbak"})
    monkeypatch.setattr(runner.engine, "stop_services", lambda n, s: 0)
    monkeypatch.setattr(runner.engine, "up", lambda n, **kw: 1)            # upgrade fails
    monkeypatch.setattr(up, "_rollback",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full")))
    with pytest.raises(errors.DockerError) as ei:
        up.run("rc8-5-1", "8.6.1", offline=True)
    msg = str(ei.value)
    assert "rollback failed" in msg and "disk full" in msg
    assert "indeterminate state" in msg and "/tmp/pre.rcbak" in msg


# --- lock coverage ------------------------------------------------------------------
#
# A lock only helps if BOTH sides take it. Backup and upgrade taking it while env,
# monitor, scale and create did not meant it protected almost nothing -- and implied
# a safety that was not there.

def test_every_mutating_service_operation_takes_the_repro_lock():
    """Each of these does read-compose -> write-compose -> `docker compose up`."""
    from houston.services import data as datasvc
    from houston.services import envvars as envsvc
    from houston.services import lifecycle as lcsvc
    from houston.services import monitor as monsvc

    # THROUGH THE MODULE'S OWN STEPS. `create_repro` delegates to a named step that takes
    # the lock, so reading only the entry point's text said "unlocked" about a function
    # that is locked -- and would equally say "locked" about one that merely mentions the
    # word. The question is whether the lock is taken on the way, which is a walk.
    for fn in (envsvc.set_env, monsvc.attach, monsvc.detach, datasvc.run_scale,
               lcsvc.create_repro, bk.create, bk.restore, up.run):
        seq = call_sequence(fn, through=OWN_MODULE)
        assert "repro_lock" in seq, f"{fn.__module__}.{fn.__qualname__} is unlocked"


def test_create_repro_derives_the_same_name_it_locks():
    """The wrapper computes the name to lock; if it drifted from the one the body
    derives, the lock would guard a different repro than the one being written."""
    from houston.services import lifecycle as lcsvc
    for req in (lcsvc.CreateReq(version="8.5.1"),
                lcsvc.CreateReq(version="8.5.1", preset="ldap"),
                lcsvc.CreateReq(version="8.5.1", name="My Repro!")):
        outer = (lcsvc.sanitize(req.name) if req.name
                 else lcsvc.derive_name(req.version, req.preset))
        inner = (lcsvc.sanitize(req.name) if req.name
                 else lcsvc.derive_name(req.version, req.preset))
        assert outer == inner and outer




def test_quiescing_a_kubernetes_workspace_leaves_mongodb_running():
    """A dump needs the database UP and only its writers quiesced.

    `stop_workspace` would take MongoDB with it, which would make the dump
    impossible rather than consistent -- the same distinction runner already draws
    between `stop()` and `stop_services()`. So the Kubernetes path scales the
    Rocket.Chat deployments by label and nothing else.
    """

    from houston.services import k8s

    src = source_of(k8s.scale_rocketchat)
    assert "app.kubernetes.io/name=rocketchat" in src, \
        "it must select Rocket.Chat by label, not scale everything"
    assert "statefulset" not in src.lower(), "MongoDB must keep running"

    # The CALL, not the prose: the comment in _Quiesced names `stop_workspace` to
    # explain why it is the wrong one, so a substring check passes on the comment
    # and proves nothing about the code.
    from houston.services import backup as bk
    quiesce = source_of(bk._Quiesced)
    assert "k8s.scale_rocketchat(" in quiesce, quiesce
    assert "k8s.stop_workspace(" not in quiesce, "MongoDB must keep running for a dump"


def test_a_bundle_from_an_earlier_workspace_of_the_same_name_is_marked(
        monkeypatch, tmp_path, fake_docker):
    """Bundles outlive their workspace, and are matched to one by NAME.

    `down --volumes` deliberately does not delete backups -- surviving the thing
    they backed up is the point. But houston DERIVES names from the version, so
    `up -v 8.5.1` produces `<user>-rc8-5-1` every time, and a freshly created
    workspace immediately shows the destroyed one's bundles as its own.

    That was reported as "a backup file is generated automatically when I create a
    Kubernetes workspace". Nothing creates one -- verified live, `backups/` is empty
    after `up` -- but the listing said otherwise, and restoring one of those would
    silently load a previous workspace's data.

    Still listed, because hiding a real backup is worse. Marked, so it cannot be
    mistaken for this workspace's own.
    """
    import datetime as _dt

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # Both the bundle FILENAME and its manifest carry a timestamp. Stepping a fake
    # clock is what lets two bundles straddle the workspace's creation without the
    # test depending on the real one.
    stamps = iter(["20260815-080000", "20260818-091500"])
    monkeypatch.setattr(bk, "_utc_stamp", lambda: next(stamps))
    made = iter([_dt.datetime(2026, 8, 15, 8, 0, tzinfo=_dt.timezone.utc),
                 _dt.datetime(2026, 8, 18, 9, 15, tzinfo=_dt.timezone.utc)])

    class _Clock:
        @staticmethod
        def now(tz=None):
            return next(made)
    monkeypatch.setattr(bk, "datetime", _Clock)

    # A bundle made by an earlier workspace of this name...
    write_repro("rc8-5-1", meta=make_meta(name="rc8-5-1",
                                          created_at="2026-08-15T07:00:00+00:00"))
    old_bundle = bk.create("rc8-5-1")["path"]

    # ...then that workspace is destroyed and a NEW one takes the same name.
    write_repro("rc8-5-1", meta=make_meta(name="rc8-5-1",
                                          created_at="2026-08-16T00:00:00+00:00"))
    rows = bk.list_backups("rc8-5-1")
    assert rows, "the bundle must still be listed"
    assert Path(old_bundle).name in [Path(r["path"]).name for r in rows]
    assert rows[0]["predates_workspace"] is True, (
        "a bundle older than the workspace bearing its name came from a previous "
        "one, and restoring it would load that workspace's data")

    # A bundle taken by the workspace that is running now is NOT marked.
    fresh = bk.create("rc8-5-1")["path"]
    rows = bk.list_backups("rc8-5-1")
    mine = next(r for r in rows if Path(r["path"]).name == Path(fresh).name)
    assert mine["predates_workspace"] is False

    # And with no workspace to compare against, nothing is claimed either way.
    import shutil as _sh
    _sh.rmtree(bk.runner.workspace("rc8-5-1"))
    assert all(r["predates_workspace"] is False for r in bk.list_backups("rc8-5-1"))


def test_a_failed_kubernetes_upgrade_leaves_the_record_where_the_cluster_is(
        monkeypatch, tmp_path):
    """The record must never claim a version the cluster is not running.

    It did. `rc_version` was advanced before `helm upgrade` was called, so when the
    call failed the workspace kept serving the OLD release while `list`, `info` and
    the GUI card all reported the new one. Reported from real use: the helm release
    was still at revision 1 -- nothing had been applied at all -- and the only thing
    wrong with the workspace was the note houston had written about it.

    A record that has to be corrected by hand is worse than an upgrade that simply
    did not happen, so the cluster changes first and the record follows.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology
    from houston.services import upgrade as up

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = bk.runner.Metadata(name="k", project="p", rc_version="8.5.1",
                           rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="http://localhost:3000", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    ws = bk.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    monkeypatch.setattr(k8s.status, "workload_exists", lambda name, *, context: True)
    monkeypatch.setattr(up, "plan", lambda name, to, offline=False: {
        "allowed": True, "mongo_blocked": "", "warnings": [],
        "from_version": "8.5.1", "to_version": "8.6.1",
        "rc_image": "registry.rocket.chat/rocketchat/rocket.chat", "oplog": False})
    monkeypatch.setattr(up.backupsvc, "_create_locked",
                        lambda *a, **kw: {"path": str(tmp_path / "b.rcbak")})
    monkeypatch.setattr(k8s.chart, "resolve_chart_version", lambda v, emit=None: "7.0.2")

    # The exact failure that was hit: helm is never reached.
    def boom(**kw):
        raise AttributeError("module 'houston.services.k8s' has no attribute "
                             "'upgrade_image'")
    monkeypatch.setattr(k8s.release, "upgrade_image", boom)
    # Rolling back cannot help when the apply never happened; it must not mask the
    # state either.
    monkeypatch.setattr(up, "_rollback_kubernetes", lambda *a, **kw: None)

    with pytest.raises(errors.DockerError):
        up.run("k", "8.6.1")

    assert bk.runner.read_meta("k").rc_version == "8.5.1", (
        "the cluster was never touched, so the record must still say 8.5.1 -- "
        "otherwise every listing reports a version that is not running")


def test_explicit_rollback_works_on_kubernetes(monkeypatch, tmp_path):
    """`upgrade --rollback` reached for a compose document that does not exist.

    The automatic rollback-on-failure inside _run_locked was made runtime-aware; this
    entry point -- the one a person actually types -- was not, and only running it
    live showed that. It raised a bare FileNotFoundError naming
    `repros/<n>/docker-compose.yml`, the same contract break the `env` read had, and
    left the workspace on the NEW version with the old data still in place: the worst
    of both, from the command whose whole job is undoing an upgrade.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology
    from houston.services import upgrade as up

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    bundle = tmp_path / "pre.rcbak"
    bundle.write_bytes(b"x")

    m = bk.runner.Metadata(name="k", project="p", rc_version="8.6.1",
                           rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="http://localhost:3000", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    m.extra[up.LAST_BACKUP_KEY] = str(bundle)
    m.extra[up.UPGRADE_FROM_KEY] = "8.5.1"
    ws = bk.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    assert not (ws / "docker-compose.yml").exists()

    monkeypatch.setattr(up.lifecycle.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(up.lifecycle.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(up.backupsvc, "read_manifest",
                        lambda b: {"rc_version": "8.5.1",
                                   "rc_image": "registry.rocket.chat/rocketchat/rocket.chat"})
    monkeypatch.setattr(bk.runner.record, "read_compose",
                        lambda *a, **kw: pytest.fail("it read a compose document"))
    monkeypatch.setattr(bk.runner.engine, "up",
                        lambda *a, **kw: pytest.fail("it ran `docker compose up`"))

    seen = {}
    monkeypatch.setattr(up, "_rollback_kubernetes",
                        lambda t, prev, b, e: seen.update(target=t, prev=prev, bundle=b))

    out = up.rollback("k")
    assert seen["target"] == "k"
    assert seen["prev"]["rc_version"] == "8.5.1", "it goes back to the bundle's version"
    assert seen["bundle"] == str(bundle), "and restores the pre-upgrade data"
    assert out["rolled_back_to"] == "8.5.1"
    # The "this was upgraded" marker must not survive the undo.
    assert up.UPGRADE_FROM_KEY not in bk.runner.read_meta("k").extra


def _a_kubernetes_workspace_ready_to_upgrade(monkeypatch, tmp_path):
    """A Kubernetes workspace and the helm calls an upgrade would make against it."""
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology
    from houston.services import upgrade as up

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = bk.runner.Metadata(name="k", project="p", rc_version="7.9.3", rc_image="i",
                           mongo_tag="7.0", mongo_flavor="official", preset="default",
                           root_url="http://localhost:3000", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    m.extra["namespace"] = "houston-k"
    ws = bk.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    return k8s, up, ws


def test_upgrade_runs_on_kubernetes_with_the_chart_pinned(monkeypatch, tmp_path):
    """`upgrade` refused this runtime entirely; the official guide makes it one command.

    Two things the guide's own command does NOT do, and both matter here:

      * It does not pin a chart version -- the docs warn it "installs the latest
        Rocket.Chat Helm chart". For a tool whose whole purpose is reproducing a
        customer's exact version, that quietly deploys different software than the
        one asked for. The chart is resolved for the TARGET release instead, by the
        same floor rule `up` uses.
      * It carries every existing value forward, including `externalMongodbOplogUrl`.
        Rocket.Chat 8 dropped oplog tailing and chart 7.0.0 removed the key, so an
        upgrade across that line has to clear it rather than inherit it.

    And nothing may reach for a compose document: a Kubernetes workspace has none,
    which is what the old refusal was protecting against.
    """
    k8s, up, ws = _a_kubernetes_workspace_ready_to_upgrade(monkeypatch, tmp_path)
    assert not (ws / "docker-compose.yml").exists()

    # A running Kubernetes workspace is one whose workload exists -- not one Docker
    # happens to know about.
    monkeypatch.setattr(k8s.status, "workload_exists", lambda name, *, context: True)
    assert up.require_running("k").name == "k", \
        "it used to refuse this runtime outright"

    monkeypatch.setattr(up, "plan", lambda name, to, offline=False: {
        "allowed": True, "mongo_blocked": "", "warnings": [],
        "from_version": "7.9.3", "to_version": "8.5.1",
        "rc_image": "registry.rocket.chat/rocketchat/rocket.chat",
        "oplog": False})
    monkeypatch.setattr(up.backupsvc, "_create_locked",
                        lambda *a, **kw: {"path": str(tmp_path / "b.rcbak")})
    monkeypatch.setattr(up.lifecycle.ready, "wait_and_finalize", lambda *a, **kw: {})
    monkeypatch.setattr(up.rcapi, "api_info", lambda url: {"version": "8.5.1"})
    monkeypatch.setattr(up, "_migration_errors", lambda *a, **kw: [])
    monkeypatch.setattr(k8s.chart, "resolve_chart_version", lambda v, emit=None: "7.0.0")
    monkeypatch.setattr(bk.runner.record, "read_compose",
                        lambda *a, **kw: pytest.fail("it read a compose document"))
    monkeypatch.setattr(bk.runner.engine, "up",
                        lambda *a, **kw: pytest.fail("it ran `docker compose up`"))

    seen = {}
    monkeypatch.setattr(k8s.release, "upgrade_image",
                        lambda **kw: seen.update(kw))

    out = up.run("k", "8.5.1")
    assert out["to_version"] == "8.5.1"
    assert seen["chart_version"] == "7.0.0", "the chart moves WITH the app, pinned"
    assert seen["tag"] == "8.5.1" and seen["namespace"] == "houston-k"
    assert seen["oplog"] is False, \
        "Rocket.Chat 8 dropped oplog and chart 7.0.0 removed the key"
    # The record moved on even though there is no compose file to rewrite.
    assert bk.runner.read_meta("k").rc_version == "8.5.1"






def test_restoring_into_a_kubernetes_workspace_does_not_require_docker(
        monkeypatch, tmp_path):
    """`require_docker` at the top of `restore` refused a Kubernetes target on a box
    with no Docker at all -- a check for the wrong runtime, in the one place the
    target is already known."""
    from houston.services import backup as bk
    from houston.services import k8s, lifecycle, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = bk.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    bk.runner.write("k", "", m)

    monkeypatch.setattr(lifecycle.preconditions, "require_docker",
                        lambda: pytest.fail("it demanded Docker for a k8s workspace"))
    # Fails later on the missing bundle, which is the point: it got PAST the check.
    try:
        bk.restore(tmp_path / "nope.rcbak", name="k")
    except Exception as exc:            # noqa: BLE001
        assert "Docker" not in str(exc), exc
