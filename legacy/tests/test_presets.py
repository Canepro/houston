"""`houston.presets`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import config
from houston import presets
import json


def test_email_preset_shape():
    p = presets.load("email")
    assert "mailpit" in p.services
    assert p.depends_on == ["mailpit"]
    assert p.env["OVERWRITE_SETTING_SMTP_Host"] == "mailpit"
    assert p.env["OVERWRITE_SETTING_SMTP_Port"] == "1025"
    # Email-2FA is enabled globally (codes land in Mailpit). No forced opt-in:
    # it only gates users with verified emails (seeded users are; admin isn't
    # until verified manually), so plain admin login keeps working.
    assert p.env["OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled"] == "true"
    assert p.post_ready == []
    # rcapi.login needs Mailpit's URL to fetch codes for houston's own calls
    # whenever a login is 2FA-gated.
    assert p.extra["mailpit_url"] == "http://localhost:8025"
    # verification is opt-in
    assert "OVERWRITE_SETTING_Accounts_EmailVerification" not in p.env
    assert (
        presets.load("email", {"verification": "true"})
        .env["OVERWRITE_SETTING_Accounts_EmailVerification"] == "true"
    )


def test_livechat_preset_shape():
    p = presets.load("livechat")
    assert "widget-site" in p.services
    assert p.env["OVERWRITE_SETTING_Livechat_enabled"] == "true"
    assert p.env["OVERWRITE_SETTING_API_Enable_CORS"] == "true"   # cross-origin widget
    # the widget iframes RC; X-Frame-Options: sameorigin would block it cross-origin
    assert p.env["OVERWRITE_SETTING_Iframe_Restrict_Access"] == "false"
    assert p.ports == [8090]
    # widget page uses the {{ROOT_URL}} placeholder (substituted at write time)
    assert "{{ROOT_URL}}/livechat" in dict(p.files)["livechat/index.html"]
    # agent + department are set up once RC is serving
    assert p.post_ready[0]["action"] == "livechat_setup"
    # department is created by default (assign agents to it), opt-out via --set
    assert p.post_ready[0]["department"] == "support"
    assert presets.load("livechat", {"department": "false"}).post_ready[0]["department"] == ""


def test_multi_instance_clamps_instance_count():
    assert presets.load("multi-instance", {"instances": "1"}).instances == 2   # min 2
    assert presets.load("multi-instance", {"instances": "99"}).instances == 5  # max 5


def test_the_idp_presets_send_the_browser_to_a_host_it_can_reach():
    """`entry_point` and the OIDC `url` are followed by the BROWSER, and both were
    hardcoded to a name that means "this machine".

    On a shared box -- one `serve` on a server, several engineers using the GUI --
    `localhost:8081` and `keycloak:8085` name each visitor's own laptop. The SAML
    button reached nothing and the browser returned to the login page; the OIDC popup
    opened a name that did not resolve and rendered blank. Neither logged anything.

    Keycloak makes it unforgiving in the other direction as well: it compares the
    AuthnRequest's Destination with the URL the request arrived on and refuses a
    mismatch with `invalid_authn_request` / `invalid_destination` -- measured against
    a live workspace by changing nothing but the hostname. So one knob moves both.
    """
    from houston import presets

    saml = presets.load("saml", {"idp_host": "rc.example.com"})
    entry = saml.env["OVERWRITE_SETTING_SAML_Custom_Default_entry_point"]
    assert entry == "http://rc.example.com:8081/realms/houston/protocol/saml", entry
    slo = saml.env["OVERWRITE_SETTING_SAML_Custom_Default_idp_slo_redirect_url"]
    assert slo == entry, "SSO and SLO are the same endpoint; they must move together"

    # The DESCRIPTOR is fetched by houston itself, not the browser, so it stays on
    # loopback -- otherwise `--set idp_host=<public name>` breaks its own cert fetch
    # on a workspace whose ports are bound to 127.0.0.1.
    cert = [a for a in saml.post_ready if a["action"] == "saml_idp_cert"][0]
    assert cert["descriptor_url"].startswith("http://localhost:8081/"), cert

    oidc = presets.load("oidc", {"idp_host": "rc.example.com"})
    prov = [a for a in oidc.post_ready if a["action"] == "create_oauth_provider"][0]
    url = prov["settings"]["Accounts_OAuth_Custom-Keycloak-url"]
    assert url == "http://rc.example.com:8085/realms/houston", url

    # Default unchanged: a laptop workspace keeps working exactly as before.
    assert "localhost:8081" in presets.load("saml", {}).env[
        "OVERWRITE_SETTING_SAML_Custom_Default_entry_point"]
    assert "keycloak:8085" in presets.load("oidc", {}).post_ready[1][
        "settings"]["Accounts_OAuth_Custom-Keycloak-url"]


def test_presigned_minio_can_be_addressed_by_the_browser_without_a_hosts_entry():
    """A presigned URL is followed by the BROWSER, and `minio` resolved for it only
    through a `127.0.0.1 minio` hosts line — which names whichever machine the
    browser is on.

    Same silent shape as the saml/oidc buttons: on a shared install the entry is
    right and the previews still break, because loopback is not this box from over
    there. Proxy mode is untouched — there Rocket.Chat streams the bytes and the
    browser never contacts MinIO at all, so `minio:9000` over the compose network is
    the more reliable answer and stays the default.
    """
    from houston import presets

    key = "OVERWRITE_SETTING_FileUpload_S3_BucketURL"
    assert presets.load("s3_minio", {}).env[key] == "http://minio:9000"
    assert presets.load("s3_minio", {"presigned": "1"}).env[key] == "http://minio:9000"

    moved = presets.load("s3_minio", {"presigned": "1", "s3_host": "box.example.com"})
    assert moved.env[key] == "http://box.example.com:9000", moved.env[key]
    # And it stops telling the reader to add a hosts entry it no longer needs.
    body = " ".join(moved.notes)
    assert "127.0.0.1  minio" not in body, body
    assert "no hosts entry is needed" in body, body

    # Proxy mode says nothing about presigned URLs either way.
    plain = " ".join(presets.load("s3_minio", {}).notes)
    assert "proxied through RC" in plain, plain


def test_a_preset_name_cannot_be_a_path(tmp_path, monkeypatch):
    """`--preset /tmp/x` read /tmp/x.yaml, and the presets directory was never consulted.

    `config.preset_dir() / f"{name}.yaml"` LOOKS like it confines the lookup and does
    not: pathlib's `/` discards the left operand when the right is absolute. No `..`
    and no existing presets directory needed.

    It matters because a preset is a container spec -- its `services:` is deep-merged
    into the compose document -- so any readable YAML on the box became an arbitrary
    image with arbitrary bind mounts. Reproduced with `volumes: ["/:/host:ro"]`. And
    `preset` is not in `PRIVILEGED_CREATE_FIELDS`, so `POST /api/repros` is member+:
    on the shared server the README warns about, any member could hand the serve
    process a container spec. Two lesser consequences: naming another workspace's
    `docker-compose.yml` pulled its Keycloak/MinIO/LDAP and their credentials into one
    of yours, and the three distinguishable errors made the create dialog a filesystem
    oracle.
    """
    from houston import presets

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    outside = tmp_path.parent / "escape-probe.yaml"
    outside.write_text("name: escaped\nservices:\n  evil: {image: alpine:3}\n")

    for bad in (str(outside)[:-5], "/etc/passwd", "../../etc/passwd",
                "sub/dir", "back\\slash", ".hidden", "-leading", "UPPER", ""):
        try:
            presets._user_path(bad)
        except ValueError as exc:
            assert "not a preset name" in str(exc) or "outside" in str(exc), (bad, exc)
        else:
            raise AssertionError(f"{bad!r} was accepted as a preset name")

    # And a real name still resolves inside the presets directory, which is the half a
    # blunt fix would break.
    for good in ("ldap", "my-preset_2", "s3-minio", "x1"):
        got = presets._user_path(good)
        assert got.parent == config.preset_dir(), (good, got)
        assert got.name == f"{good}.yaml"

    # Through the public entry point too: `load` must not read the outside file.
    try:
        presets.load(str(outside)[:-5])
    except ValueError as exc:
        assert "not a preset name" in str(exc), exc
    else:
        raise AssertionError("load() still reads a path")


def test_one_unreadable_preset_file_does_not_empty_the_catalog(tmp_path, monkeypatch):
    """`raw.get("name")` on a list or scalar is an AttributeError, not a ReproError.

    So one malformed file in the presets directory took out `houston presets`,
    `/api/presets` and the create dialog -- and made `capabilities` report ZERO
    presets, because it guards its own call with a bare `except Exception` and the
    failure became silence. A file somebody is halfway through writing must not do
    that.
    """
    from houston import presets

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    (tmp_path / "presets").mkdir(parents=True)
    (tmp_path / "presets" / "broken.yaml").write_text("- a\n- b\n")
    (tmp_path / "presets" / "scalar.yaml").write_text("just-a-string\n")
    (tmp_path / "presets" / "fine.yaml").write_text("name: fine\nenv: {}\n")

    got = {p.name: p for p in presets.list_presets()}

    assert "fine" in got and not got["fine"].error
    # The built-ins survive, which is the whole point.
    assert "ldap" in got and "saml" in got, sorted(got)
    # And the bad ones are NAMED rather than missing.
    assert got["broken"].error and "not a mapping" in got["broken"].error
    assert got["scalar"].error

    # _parse itself raises a ValueError the front-ends already render.
    try:
        presets._parse("- a\n", source="x")
    except ValueError as exc:
        assert "not a mapping" in str(exc), exc
    else:
        raise AssertionError("a list parsed as a preset")


# --- presets ------------------------------------------------------------------


def test_default_preset_loads():
    p = presets.load("default")
    assert p.name == "default"
    assert p.services == {}


def test_ldap_preset_generates_users():
    p = presets.load("ldap", {"users": "3"})
    ldif = dict(p.files)["ldap/50-rc-users.ldif"]
    assert ldif.count("dn: uid=user") == 3
    assert "openldap" in p.services
    assert p.env["OVERWRITE_SETTING_LDAP_Server_Type"] == ""  # generic, not AD


def test_saml_preset_realm_scales_with_users():
    p = presets.load("saml", {"users": "4"})
    realm = json.loads(dict(p.files)["saml/keycloak-realm.json"])
    assert [u["username"] for u in realm["users"]] == ["user1", "user2", "user3", "user4"]
    assert realm["sslRequired"] == "none"
    assert p.post_ready  # fetches the IdP cert at runtime


def test_unknown_preset_raises():
    try:
        presets.load("does-not-exist")
    except ValueError:
        return
    raise AssertionError("expected ValueError for unknown preset")


def test_multi_instance_preset_shape():
    p = presets.load("multi-instance", {"instances": "3"})
    assert p.instances == 3
    assert p.entry_service == "traefik"
    assert "nats" in p.services and "traefik" in p.services
    assert p.depends_on == ["nats"]
    # Traefik uses a generated file-provider config listing the 3 backends
    # (matches official rocketchat-compose; no Docker-socket label discovery).
    dynamic = dict(p.files)["traefik/dynamic.yml"]
    assert dynamic.count("- url:") == 3
    assert "http://rocketchat-3:3000" in dynamic
    assert all("docker.sock" not in v for v in p.services["traefik"].get("volumes", []))


def test_s3_minio_preset_shape():
    p = presets.load("s3_minio")
    assert "minio" in p.services and "minio-init" in p.services
    assert p.env["OVERWRITE_SETTING_FileUpload_Storage_Type"] == "AmazonS3"
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_ForcePathStyle"] == "true"
    # Default mode proxies downloads through RC — zero-setup, no hosts entry.
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads"] == "true"
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_Proxy_Avatars"] == "true"
    # The object store persists via a named volume (Preset.volumes).
    assert p.volumes == {"minio_data": {"driver": "local"}}
    assert p.depends_on == ["minio"]


def test_s3_minio_creates_its_bucket_on_both_runtimes():
    """MinIO running is not the same as the bucket existing.

    The test above asserts `minio-init` is in `services`, which is the COMPOSE half.
    The Kubernetes adapter rendered only the MinIO Deployment and its Services, so on
    that runtime the bucket was never created -- while the workspace's own notes said
    "bucket '<name>' is created automatically; watch uploads land in it". Neither MinIO
    nor Rocket.Chat creates a bucket on demand, so every upload had nowhere to go, and
    `up` reported success. Found by an audit that looked in the namespace and saw a
    minio Deployment with no init workload beside it.
    """
    import yaml

    from houston.services import topology

    # Compose: the one-shot service, running the idempotent mc mb.
    d = presets.resolve("s3_minio", topology.DOCKER, {"bucket": "tickets"})
    init = d.services["minio-init"]
    assert "mc mb -p local/tickets" in " ".join(init["entrypoint"])

    # Kubernetes: the same thing, as a Job.
    k = presets.resolve("s3_minio", topology.KUBERNETES, {"bucket": "tickets"})
    docs = [doc for m in k.kubernetes_manifests for doc in yaml.safe_load_all(m) if doc]
    jobs = [doc for doc in docs if doc.get("kind") == "Job"]
    assert jobs, ("nothing creates the bucket on Kubernetes: "
                  f"rendered {[doc['kind'] for doc in docs]}")
    spec = jobs[0]["spec"]["template"]["spec"]
    cmd = " ".join(spec["containers"][0]["command"])
    assert "mc mb -p local/tickets" in cmd, cmd
    assert "until mc alias set" in cmd, \
        "it must wait for MinIO; the Job is applied alongside the Deployment"
    # A Job, not an init container: an init container runs before its pod's main
    # container, so it would wait for a MinIO that cannot start until it finishes.
    assert spec["restartPolicy"] == "OnFailure"
    assert jobs[0]["spec"]["backoffLimit"] >= 1, "the first attempt races MinIO starting"
    assert (jobs[0]["metadata"]["labels"]["app.kubernetes.io/managed-by"]
            == "houston"), "teardown and ownership select on this"


def test_s3_minio_presigned_mode_and_bucket():
    p = presets.load("s3_minio", {"presigned": "true", "bucket": "tickets"})
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads"] == "false"
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_Bucket"] == "tickets"
    # The ENDPOINT, with no bucket on it. Bucket is passed separately and
    # ForcePathStyle makes the client build {endpoint}/{bucket}/{key}, so a bucket
    # here is repeated as a key prefix. Measured on 7.13.6 by uploading a file:
    # with it, objects landed under houston-uploads/houston-uploads/...; without
    # it, houston-uploads/... . docs.rocket.chat/docs/minio prescribes the bucket
    # in the URL and is wrong about it -- the upload succeeds either way, which is
    # why it went unnoticed.
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_BucketURL"] == "http://minio:9000"
    assert "tickets" not in p.env["OVERWRITE_SETTING_FileUpload_S3_BucketURL"]
    # v2, not v4: RC 7.13.x bundles aws-sdk v2, which honours this, and asking for
    # v4 makes it raise "Non-file stream objects are not supported with SigV4"
    # during startup so Rocket.Chat never finishes booting. Newer releases use
    # @aws-sdk/client-s3, which ignores the setting -- v2 is right on old images and
    # inert on new ones.
    assert p.env["OVERWRITE_SETTING_FileUpload_S3_SignatureVersion"] == "v2"
    assert any("/etc/hosts" in n for n in p.notes)   # browser needs the hosts line
    # bucket-init creates the custom bucket
    assert "local/tickets" in p.services["minio-init"]["entrypoint"][-1]


def test_s3_bucket_name_validated():
    try:
        presets.load("s3_minio", {"bucket": "Bad Name!"})
    except ValueError as exc:
        assert "bucket" in str(exc)
        return
    raise AssertionError("expected ValueError for an invalid bucket name")


def test_multi_instance_bad_count_is_actionable():
    try:
        presets.load("multi-instance", {"instances": "many"})
    except ValueError as exc:
        assert "--set instances=" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_yaml_preset_notes_parsed(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pdir = tmp_path / "presets"
    pdir.mkdir(parents=True)
    (pdir / "team.yaml").write_text(
        "name: team\nnotes: [tip one, tip two]\nparams_help: {x: does x}\n"
    )
    p = presets.load("team")
    assert p.notes == ["tip one", "tip two"]
    assert p.params_help == {"x": "does x"}


def test_keycloak_carries_both_renderings_on_one_preset():
    """Deliberately NOT a Scenario with two adapters like `ldap`.

    Keycloak's intent survives the crossing untouched: the realm JSON is
    byte-identical, the settings Rocket.Chat needs are identical, and the post_ready
    actions are REST calls that do not care where the IdP runs. Only the container's
    packaging differs -- so one Preset carries both renderings and each runtime reads
    the half it understands. Two adapters would have been two copies of the same
    realm to keep in step.
    """
    import yaml

    from houston import config, presets
    from houston.presets import _keycloak

    for name in ("saml", "oidc"):
        p = presets.load(name, {"users": "3"})
        assert "keycloak" in p.services, name
        docs = [d for d in yaml.safe_load_all(p.kubernetes_manifests[0]) if d]
        kinds = {d["kind"]: d for d in docs}
        assert set(kinds) == {"ConfigMap", "Deployment", "Service"}, sorted(kinds)

        # The realm the two renderings ship must be the SAME bytes, or a ticket
        # reproduced on one runtime is not the ticket reproduced on the other.
        compose_realm = dict(p.files)[f"{name}/keycloak-realm.json"]
        assert kinds["ConfigMap"]["data"]["houston-realm.json"] == compose_realm

        # `keycloak` on both, because RC's backend and the browser must resolve the
        # same hostname -- OIDC uses one URL for the authorize redirect AND the
        # token exchange.
        assert kinds["Service"]["metadata"]["name"] == "keycloak"
        want = config.PRESET_PORTS[name][0]
        assert kinds["Service"]["spec"]["ports"][0]["port"] == want
        assert kinds["Service"]["metadata"]["labels"][_keycloak.UI_PORT_LABEL] == str(want)


def test_the_realm_lands_as_a_file_not_a_directory():
    """A ConfigMap mounted at a file path WITHOUT subPath becomes a directory of
    that name, and Keycloak's `--import-realm` would find no realm to import. The
    LDAP adapter got this right; this asserts the Keycloak one does too, because
    the failure is silent -- the container starts happily with an empty realm."""
    import yaml

    from houston import presets

    docs = [d for d in yaml.safe_load_all(
        presets.load("oidc", {}).kubernetes_manifests[0]) if d]
    dep = [d for d in docs if d["kind"] == "Deployment"][0]
    mount = dep["spec"]["template"]["spec"]["containers"][0]["volumeMounts"][0]
    assert mount["subPath"] == "houston-realm.json", mount
    assert mount["mountPath"].endswith("/import/houston-realm.json"), mount


def test_every_scenario_workload_declares_when_it_is_ready():
    """The audit's root cause, in one assertion.

    Without a readiness probe a pod is Ready the instant its container starts --
    about forty seconds before Keycloak serves HTTP. Everything downstream then
    trusts a signal that has not been earned: the Service publishes a "ready"
    endpoint, the port-forward attaches to a backend that is not listening, and
    post_ready fetches the IdP descriptor from a port with nothing behind it.

    The operational audit caught exactly that -- SAML came up with an empty
    SAML_Custom_Default_cert and both post_ready actions failed, on a workspace that
    reported itself running.
    """
    import yaml

    from houston import presets
    from houston.services import topology

    for name in ("ldap", "saml", "oidc", "email", "s3_minio", "livechat"):
        # resolve(..., KUBERNETES): `ldap` is a Scenario whose two adapters return
        # DIFFERENT Presets, so `load` gives the Compose one with no manifests at all.
        kube = presets.resolve(name, topology.KUBERNETES, {})
        docs = [d for d in yaml.safe_load_all(kube.kubernetes_manifests[0]) if d]
        deployments = [d for d in docs if d["kind"] == "Deployment"]
        assert deployments, name
        for dep in deployments:
            container = dep["spec"]["template"]["spec"]["containers"][0]
            probe = container.get("readinessProbe")
            assert probe, f"{name}/{dep['metadata']['name']} has no readinessProbe"
            # It must test the thing that actually serves. httpGet where the
            # workload speaks HTTP; LDAP does not, so slapd gets a tcpSocket check --
            # which is meaningful there because slapd binds 389 only after its
            # bootstrap import finishes.
            assert "httpGet" in probe or "tcpSocket" in probe, f"{name}: {probe}"
            # Long enough for an image pull plus a slow boot; the cost of being wrong
            # is a workspace that looks healthy and is not configured.
            assert probe.get("failureThreshold", 3) >= 30, f"{name}: {probe}"


def test_a_service_exposes_every_port_its_workload_listens_on():
    """Reported from a live workspace: Rocket.Chat could not send mail.

        SMTP_Host=mailpit  SMTP_Port=1025      (what RC was told)
        containerPort 8025, 1025               (what Mailpit listened on)
        Service ports: 8025                    (what was reachable)

    On Compose, container-to-container traffic reaches ANY port directly, so
    `mailpit:1025` just works. A Kubernetes Service forwards only its DECLARED
    ports -- so publishing the web UI and nothing else produced a workspace whose
    Mailpit answered the browser and refused Rocket.Chat, which is where the mail
    has to come from. Both UIs worked, which is exactly why it was not noticed.

    The Service speaks CONTAINER ports, as Compose's network does; the `ui-port`
    label is what says which host port publishes one.
    """
    import yaml

    from houston import presets
    from houston.services import topology

    def services(name):
        docs = yaml.safe_load_all(
            presets.resolve(name, topology.KUBERNETES, {}).kubernetes_manifests[0])
        return {d["metadata"]["name"]: d for d in docs if d and d["kind"] == "Service"}

    mailpit = services("email")["mailpit"]
    ports = {p["port"] for p in mailpit["spec"]["ports"]}
    assert ports == {8025, 1025}, f"SMTP must be reachable in-cluster: {ports}"
    # The published one first: the forwarder reads .spec.ports[0].
    assert mailpit["spec"]["ports"][0]["port"] == 8025, mailpit["spec"]["ports"]

    # MinIO serves API and console from one process; both are published, so the
    # second gets its own Service naming the workload it belongs to.
    minio = services("s3_minio")
    assert {p["port"] for p in minio["minio"]["spec"]["ports"]} == {9000, 9001}
    assert minio["minio-console"]["metadata"]["labels"][
        "houston.io/ui-deployment"] == "minio"


def test_every_port_a_preset_configures_rocket_chat_to_use_is_reachable():
    """The general rule the Mailpit bug broke: if a preset points Rocket.Chat at
    `<host>:<port>`, a Service must actually carry that port.

    Asserted against the settings themselves rather than a hand-written list, so a
    preset that gains a new backing port cannot quietly skip its Service.
    """
    import re

    import yaml

    from houston import presets
    from houston.services import topology

    for name in ("email", "s3_minio", "ldap", "oidc"):
        kube = presets.resolve(name, topology.KUBERNETES, {})
        svc_ports = {}
        for doc in yaml.safe_load_all(kube.kubernetes_manifests[0]):
            if doc and doc["kind"] == "Service":
                svc_ports[doc["metadata"]["name"]] = {
                    p["port"] for p in doc["spec"]["ports"]}

        # Settings of the form Host=<service> paired with Port=<n>.
        env = kube.env or {}
        hosts = {k.rsplit("_", 1)[0]: v for k, v in env.items() if k.endswith("_Host")}
        for prefix, host in hosts.items():
            port_val = env.get(f"{prefix}_Port")
            if not port_val or host not in svc_ports:
                continue
            port = int(re.sub(r"\D", "", str(port_val)) or 0)
            assert port in svc_ports[host], (
                f"{name}: Rocket.Chat is pointed at {host}:{port} but the {host} "
                f"Service exposes {sorted(svc_ports[host])}")


def test_the_oidc_realm_accepts_the_callback_of_an_https_workspace():
    """`--preset oidc --domain x.example.com` gave Rocket.Chat a Site_Url of
    `https://x.example.com` and a Keycloak client that allowed only
    `http://localhost*` back.

    Keycloak refuses an unlisted callback outright -- "Invalid parameter:
    redirect_uri" -- so the combination could never have worked, and nothing refused
    it at create time either. The callback is Rocket.Chat's own
    `<Site_Url>/_oauth/keycloak` and has nothing to do with the IdP's hostname, so
    the patterns have to cover both schemes.
    """
    import json

    from houston import presets

    realm = json.loads(presets.load("oidc", {}).files[0][1])
    uris = realm["clients"][0]["redirectUris"]
    assert any(u.startswith("https://") for u in uris), uris
    assert any(u.startswith("http://") for u in uris), uris
