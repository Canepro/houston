"""`houston.services.backup`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from houston import errors
from houston.services import backup as bk
import json
import pytest
import tarfile


def test_database_falls_back_when_there_is_no_compose():
    assert bk.database_of("nonexistent") == bk.DEFAULT_DATABASE


def test_delete_rejects_traversal_but_allows_a_symlinked_bundle(tmp_path):
    """The parent check is deliberately UNRESOLVED.

    Traversal is refused either way. Resolving would additionally refuse a symlink
    parked in the backups directory -- a reasonable way to keep bundles on another
    disk, and one whose unlink() removes the link, never the target.
    """
    outside = tmp_path / "outside.rcbak"
    outside.write_text("x")

    with pytest.raises(errors.ValidationError, match="managed backup directory"):
        bk.delete(bk.backups_dir() / ".." / ".." / outside.name)
    assert outside.exists()

    link = bk.backups_dir() / "link.rcbak"
    link.symlink_to(outside)
    assert bk.delete(link)["deleted"].endswith("link.rcbak")
    assert not link.exists() and outside.exists(), "the target must survive"


def test_backup_uses_kubectl_for_a_kubernetes_workspace_and_compose_for_a_compose_one(
        monkeypatch, tmp_path):
    """backup.py's LOGIC is runtime-agnostic -- the bundle format, the manifest, the
    safety checks are the same on both -- so only the five places that actually
    touch a container differ, and each asks `_kube` which runtime it is on.

    The alternative was a second copy of a 699-line module, which is how the admin
    environment ended up drifting between compose.py and the Kubernetes values.
    """
    from houston.services import backup as bk
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = bk.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    bk.runner.write("k", "", m)

    monkeypatch.setattr(bk.runner.engine, "compose_exec_capture",
                        lambda *a, **kw: pytest.fail("it reached for docker compose"))
    seen = []
    monkeypatch.setattr(k8s.transfer, "exec_capture",
                        lambda n, argv, **kw: (seen.append(argv), (0, "ok"))[1])
    assert bk._exec_capture("k", ["true"]) == (0, "ok")
    assert seen == [["true"]], seen

    # A Compose workspace must still go the other way -- this is a fork, not a swap.
    c = bk.runner.Metadata(name="c", project="houston-c", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3001,
                           version_source="t")
    bk.runner.write("c", "", c)
    monkeypatch.setattr(bk.runner.engine, "compose_exec_capture", lambda *a, **kw: (0, "compose"))
    monkeypatch.setattr(k8s.transfer, "exec_capture",
                        lambda *a, **kw: pytest.fail("it reached for kubectl"))
    assert bk._exec_capture("c", ["true"]) == (0, "compose")


def _a_workspace_whose_mongodb_needs_a_password(monkeypatch, tmp_path):
    """A workspace whose database the operator made, which means credentials."""
    from houston.services import backup as bk
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def workspace(name, managed_by):
        m = bk.runner.Metadata(name=name, project=f"p-{name}", rc_version="8.5.1",
                               rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                               preset="default", root_url="u", host_port=3000,
                               version_source="t")
        topology.stamp(m.extra, topology.KUBERNETES)
        m.extra["context"] = k8s.CONTEXT
        if managed_by:
            m.extra["mongo_managed_by"] = managed_by
        bk.runner.write(name, "", m)

    import base64 as _b64
    secret = _b64.b64encode(b"s3cr3t-generated").decode()

    def fake_run(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        if "secret" in argv:
            return sp.CompletedProcess(argv, 0, secret, "")
        return sp.CompletedProcess(argv, 1, "", "")
    monkeypatch.setattr(k8s.kube, "run", fake_run)

    # --- operator: credentials are supplied -------------------------------
    workspace("op", "operator")
    args = bk._mongo_auth("op")
    return args, bk, k8s, workspace


def test_the_database_tools_authenticate_when_the_operator_manages_mongodb(
        monkeypatch, tmp_path):
    """The operator enables SCRAM, so an unauthenticated mongodump cannot read.

    Backup was BROKEN on the operator path -- the one the official Rocket.Chat guide
    recommends -- and worked on the hand-written StatefulSet, which has no auth. Both
    paths existed; only one was ever exercised, so `mongodump` failed with
    "(Unauthorized) Command listCollections requires authentication" and the bundle
    was never written. Found by running both.

    The password is read back out of the Secret on demand, never stored: it is
    generated at create time and deliberately kept off disk, which another test
    pins by scanning `repros/<n>/kubernetes/`.
    """
    args, bk, k8s, workspace = _a_workspace_whose_mongodb_needs_a_password(monkeypatch, tmp_path)
    assert args == ["--username", k8s.MONGO_APP_USER, "--password", "s3cr3t-generated",
                    "--authenticationDatabase", k8s.MONGO_APP_DB], args
    # authenticationDatabase is the APPLICATION db, not `admin`: the user is defined
    # there, and authenticating against admin looks for a user never created in it.
    assert "admin" not in args[-1], "the app user lives in the application database"

    # --- plain StatefulSet: unchanged, because it has no auth at all -------
    workspace("plain", None)
    assert bk._mongo_auth("plain") == [], \
        "the StatefulSet path runs without authentication; adding flags would break it"

    # --- compose: never reaches Kubernetes at all --------------------------
    c = bk.runner.Metadata(name="c", project="p-c", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3001, version_source="t")
    bk.runner.write("c", "", c)
    assert bk._mongo_auth("c") == []

    # --- and the flags actually reach mongodump AND mongorestore ----------
    src = source_of(bk)
    for tool in ("mongodump", "mongorestore"):
        idx = src.index(f'"{tool}"')
        window = src[idx:idx + 320]
        assert "_mongo_auth(" in window, \
            f"{tool} is still invoked without credentials"


def _a_kubernetes_workspace_being_backed_up(monkeypatch, tmp_path):
    """A running Kubernetes workspace, and every call a backup would make against it."""
    from houston.services import backup as bk
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def workspace(name, runtime):
        m = bk.runner.Metadata(name=name, project=f"p-{name}", rc_version="8.5.1",
                               rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                               preset="default", root_url="u", host_port=3000,
                               version_source="t")
        topology.stamp(m.extra, runtime)
        if runtime == topology.KUBERNETES:
            m.extra["context"] = k8s.CONTEXT
        bk.runner.write(name, "", m)
        return m

    waited: list[str] = []
    monkeypatch.setattr(bk.lifecycle.ready, "wait_serving",
                        lambda meta, *a, **kw: waited.append(meta.name) or {})
    monkeypatch.setattr(bk.lifecycle.ready, "wait_and_finalize",
                        lambda *a, **kw: pytest.fail(
                            "a backup must not re-run finalize/post_ready and "
                            "re-apply the workspace's configuration"))

    # --- Kubernetes: the doomed forward is killed, a fresh one established ---
    m = workspace("k", topology.KUBERNETES)
    m.extra["port_forward_pid"] = 4242
    bk.runner.write("k", "", m)
    scaled: list[int] = []
    killed: list[int] = []
    monkeypatch.setattr(k8s.scale, "scale_rocketchat",
                        lambda n, *, replicas, context: scaled.append(replicas) or 0)
    # `**kw`: `_stop_port_forward` takes the namespace now, because "is this a
    # kubectl port-forward" was liveness dressed as identity and a recycled pid
    # belonging to another workspace passed it.
    monkeypatch.setattr(bk.lifecycle.ready, "_stop_port_forward",
                        lambda pid, **kw: killed.append(pid))
    with bk._Quiesced("k", [], bk.null_emit):
        pass
    return bk, k8s, killed, scaled, topology, waited, workspace


def test_backup_leaves_a_kubernetes_workspace_reachable_on_its_own_port(
        monkeypatch, tmp_path):
    """Scaling Rocket.Chat to 0 kills the port-forward along with the pod.

    Found by an operational audit, not by the suite. `backup` reported success and
    left the workspace RUNNING but unreachable at its own URL: the new pod was
    healthy and answered in-cluster, while the published port timed out. Nothing in
    the failure pointed at the backup, which was the one part that had worked --
    `houston start` then "fixed" it, because start ends in `ready`.

    `restore` never had this bug because it finishes with wait_and_finalize. This
    asserts the CALL happens on the Kubernetes path, and that Compose -- where
    start_services rebinds the published port itself -- does not pay for it.
    """
    bk, k8s, killed, scaled, topology, waited, workspace = _a_kubernetes_workspace_being_backed_up(monkeypatch, tmp_path)
    assert scaled == [0, 1], f"it must quiesce and restart Rocket.Chat, got {scaled}"
    assert killed == [4242], (
        "the forward whose pod was just deleted must be killed, not trusted to die: "
        "ensure_port_forward only asks whether the PROCESS is alive, so a doomed "
        "forward gets reused and can even serve one request before it exits")
    assert bk.runner.read_meta("k").extra.get("port_forward_pid") is None, \
        "a dead forward's pid must not stay in the record for the next caller to reuse"
    assert waited == ["k"], (
        "after scaling back up nothing was forwarding to the NEW pod, so the "
        "workspace was left unreachable on its published port")

    # --- Compose: STARTED is not SERVING there either ---------------------
    # The container returns at once and Rocket.Chat needs ~30s more, so the next
    # request got a connection reset. Compose healed itself, which is why only the
    # Kubernetes half of this was noticed first.
    waited.clear()
    workspace("c", topology.DOCKER)
    monkeypatch.setattr(bk.runner.engine, "stop_services", lambda *a, **kw: 0)
    monkeypatch.setattr(bk.runner.engine, "start_services", lambda *a, **kw: 0)
    monkeypatch.setattr(k8s.scale, "scale_rocketchat",
                        lambda *a, **kw: pytest.fail("it scaled a compose workspace"))
    with bk._Quiesced("c", ["rocketchat"], bk.null_emit):
        pass
    assert waited == ["c"], "backup must not return before Rocket.Chat serves again"

    # --- --live skips the whole dance ------------------------------------
    waited.clear()
    monkeypatch.setattr(k8s.scale, "scale_rocketchat",
                        lambda *a, **kw: pytest.fail("--live must not scale anything"))
    with bk._Quiesced("k", [], bk.null_emit, skip=True):
        pass
    assert waited == [], "--live never stopped it, so there is nothing to wait for"


def test_a_truncated_bundle_fails_inside_the_error_contract(tmp_path):
    """A truncated bundle raised a bare `EOFError` from gzip, so the CLI's
    `except ReproError` missed it and Typer printed `Aborted.` at exit 1 -- which is
    what a cancelled confirmation prompt prints. The one failure mode that looked
    like the user's own doing.

    It also escaped the `--json` envelope and the web layer's status mapping, which
    answered a bare 500.

    Measured across real corruption modes, and the gap is narrow rather than the
    whole function: random bytes, an empty file, a gzip header followed by junk and a
    mid-stream corruption were all reported properly as ValidationError. Only
    TRUNCATION escaped -- `EOFError` is not a `tarfile.TarError`, not an `OSError` and
    not a `ValueError`, so none of the existing clauses caught it.
    """
    import io

    good = tmp_path / "good.tar.gz"
    with tarfile.open(good, "w:gz") as tar:
        body = json.dumps({"schema": bk.SCHEMA, "name": "x"}).encode("utf-8")
        item = tarfile.TarInfo(bk.MANIFEST)
        item.size = len(body)
        tar.addfile(item, io.BytesIO(body))
    raw = good.read_bytes()

    for label, data in (("half", raw[: len(raw) // 2]),
                        ("gzip header only", raw[:10])):
        cut = tmp_path / f"cut-{label.replace(' ', '-')}.tar.gz"
        cut.write_bytes(data)
        with pytest.raises(errors.ValidationError) as caught:
            bk.read_manifest(cut)
        assert "truncated" in str(caught.value), (label, str(caught.value))

    # The modes that already worked must keep their own wording -- a fix that
    # relabelled every unreadable file "truncated" would be worse than the bug.
    junk = tmp_path / "junk.tar.gz"
    junk.write_bytes(b"not a gzip at all")
    with pytest.raises(errors.ValidationError) as other:
        bk.read_manifest(junk)
    assert "not a readable backup bundle" in str(other.value), other.value


def test_a_restore_retargets_site_url_at_the_workspace_it_landed_in(monkeypatch,
                                                                    tmp_path):
    """A restore is a full mongorestore, so the bundle brings its Site_Url with it.

    Measured: source on 3111, restored to 3000, `env` reporting
    ROOT_URL=http://localhost:3000 and `GET /api/v1/settings/Site_Url` answering
    http://localhost:3111 -- with /api/info then advertising
    `"workspaceUrl": "localhost:3111"` while serving on 3000. ROOT_URL does not
    override a stored setting.

    Wrong in exactly the field a restored workspace is usually restored to look at:
    Rocket.Chat derives email links, OAuth/SAML/OIDC redirect URIs, integration
    callbacks and mobile deep links from it -- and if the source is still running, all
    of them open the source. `configimport.py` denies Site_Url on import for this
    reason and the restore path had no equivalent.
    """

    from houston import rcapi
    from houston import runner
    from houston.services import backup, lifecycle as lc

    # FIRST, and by source: the pre-fix tree has no retarget step at all, and this must
    # fail for that reason rather than on a missing attribute name.
    assert "Site_Url" in source_of(backup), (
        "nothing in the restore path touches Site_Url - a bundle from another "
        "workspace still names that workspace")
    # `restore()` resolves the target and delegates; the work is in `_restore_locked`.
    assert "_retarget_site_url" in source_of(backup._restore_locked), (
        "the restore path does not retarget Site_Url")

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = lc.runner.Metadata(
        name="restored", project="houston-restored", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map")
    monkeypatch.setattr(runner.record, "read_meta", lambda n: meta)
    monkeypatch.setattr(lc.admin, "login", lambda m: object())
    monkeypatch.setattr(backup.lifecycle.admin, "login", lambda m: object())
    monkeypatch.setattr(rcapi, "get_setting",
                        lambda *a, **k: "http://localhost:3111")
    wrote: list = []
    monkeypatch.setattr(rcapi, "set_setting",
                        lambda url, auth, pw, key, val: wrote.append((key, val)) or True)

    said: list = []
    backup._retarget_site_url("restored", lambda ev: said.append(ev.message))

    assert wrote == [("Site_Url", "http://localhost:3000")], wrote
    assert any("3111" in m for m in said), said

    # A workspace whose Site_Url ALREADY matches is left alone -- this must not write
    # a setting on every restore into the same workspace.
    wrote.clear()
    monkeypatch.setattr(rcapi, "get_setting",
                        lambda *a, **k: "http://localhost:3000")
    backup._retarget_site_url("restored", lambda ev: None)
    assert wrote == [], wrote


def test_scale_and_the_profiler_use_the_workspace_s_own_database():
    """Both hardcoded `DB = "rocketchat"` and a localhost URI built from it.

    `env --set MONGO_URL=...` is supported and documented, and `backup.database_of()`
    exists for exactly this reason -- its docstring says "dumping the wrong database
    would produce an empty backup that only looks fine". On an overridden workspace
    `seed --scale users=50000` inserted into a database Rocket.Chat was not reading,
    reported `inserted: 50000`, and left the directory empty; `--clear-scale` then
    reported removing them, so the round trip was internally consistent and externally
    wrong. Same for `--diag`'s slow-query capture.
    """
    from houston import scaleseed
    from houston.perf import mongoprof
    from houston.services import backup as bk

    for mod in (scaleseed, mongoprof):
        assert hasattr(mod, "_db_of"), f"{mod.__name__} still hardcodes its database"
        assert hasattr(mod, "_uri_for"), f"{mod.__name__} still hardcodes its URI"
        assert not hasattr(mod, "_URI"), f"{mod.__name__} kept the hardcoded URI"
        # And it reads through the one function that already answers this question.
        assert "database_of" in source_of(mod._db_of)

    # The fallback is still the default, so a workspace whose compose cannot be read
    # behaves as before rather than failing.
    assert scaleseed._db_of("no-such-workspace") == scaleseed.DB
    assert bk.database_of.__doc__ and "MONGO_URL" in bk.database_of.__doc__
