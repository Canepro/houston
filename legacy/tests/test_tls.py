"""`houston.tls`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from corehelpers import _tls_spec
from edgehelpers import _doc, _write_acme
from houston import errors
from houston.services import edge as fd
from houston.services import lifecycle as lc
from servicehelpers import (
    _capture_create, _dns_env, _kube_tls_env, _local_spec, _pin_edge, _req
)
import pytest


def test_staging_notes_never_claim_the_certificate_is_trusted():
    """A Let's Encrypt STAGING root is in no trust store — that is the point.

    The notes said "Publicly trusted, so the mobile app accepts it with nothing to
    install" for staging too, which sent people hunting for a broken workspace when
    the browser warning was the correct, expected outcome.
    """
    from houston import tls
    spec = tls.TlsSpec(mode=tls.MODE_ACME, host="rc1.example.com", port=443,
                       acme_email="a@b.c", acme_staging=True)
    text = " ".join(tls.notes(spec, "rc1")).lower()
    assert "staging" in text
    assert "not trusted" in text, "staging must say plainly that it is untrusted"
    assert "publicly trusted" not in text
    assert "success signal" in text, "a warning on staging is expected, not a failure"
    # And it must say how to get a real one.
    # Staging is a config key now, not a flag on `up` -- so the way back to a
    # trusted certificate has to name the command that actually turns it off.
    assert "config unset acme.staging" in text
    # The name is threaded in, so the hint is copy-pasteable.
    assert "tls-status --name rc1" in " ".join(tls.notes(spec, "rc1"))

    prod = tls.TlsSpec(mode=tls.MODE_ACME, host="rc1.example.com", port=443,
                       acme_email="a@b.c")
    assert "publicly trusted" in " ".join(tls.notes(prod, "rc1")).lower()


def test_verify_can_present_a_different_sni_than_the_address_it_dials():
    """tls-status must probe THIS host, not the public name.

    Checking the hostname meant a proxy in front (Cloudflare's orange cloud)
    answered instead, and its valid edge certificate was reported as ours while
    our own Traefik had none.
    """
    import inspect
    from houston import tls
    sig = inspect.signature(tls.verify)
    assert "sni" in sig.parameters
    src = source_of(tls.verify)
    assert "server_hostname=servername" in src
    assert "server_hostname=host" not in src, "every handshake must honour sni"


def test_a_certificate_with_no_subject_still_says_what_it_is_for():
    """cert-manager issues with NO subject at all -- the name is in the SANs only.

    So every Kubernetes workspace's certificate reported `Subject: ?`, which reads as
    a failure to parse rather than as a perfectly good certificate. `tls_local.py`
    already says why the SANs are the field that matters: browsers have ignored
    commonName since Chrome 58, so a certificate with only a CN is rejected outright.
    """
    from houston import tls as tlsmod
    from houston import tls_local

    crt, _ = tls_local.issue_leaf("probe.houston.localhost")
    assert "probe.houston.localhost" in tlsmod.cert_names(crt)
    assert "localhost" in tlsmod.cert_names(crt), "the leaf carries both"
    # Anything unparseable is an empty list, never an exception: this feeds a report.
    assert tlsmod.cert_names("not a certificate") == []


def test_no_reachability_guessing_stands_between_you_and_a_certificate(tmp_path,
                                                                       monkeypatch):
    """How traffic reaches this host is the operator's business.

    The old path refused to create the repro when the name did not resolve, resolved
    privately, or sat behind a proxy -- guesses this process cannot make correctly
    (it cannot see a tunnel, a port-forward or a firewall), and the single biggest
    source of confusion here.
    """
    from houston import runner, tls
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": True)
    for probe in ("dns_preflight", "reachability_gaps", "resolves_to",
                  "host_has_public_address"):
        assert not hasattr(tls, probe), f"{probe} should be gone"
    # A name that resolves nowhere is still accepted.
    spec = lc._resolve_tls(_req(domain="nowhere.invalid", acme_email="a@b.c"), "x", "")
    assert spec.mode == tls.MODE_ACME


def test_every_tls_attribute_the_cli_and_web_reach_for_exists():
    """Catches a module attribute that moved out from under a caller.

    Splitting the local CA into tls_local left `trust-ca` calling tls.ensure_ca(),
    which ruff cannot see (it is an attribute access, not a name) and no test
    exercised -- so it would have failed only when a user ran the command.
    """
    import ast
    import pathlib

    from houston import tls, tls_local
    mods = {"tlsmod": tls, "tls": tls, "tls_local": tls_local}
    missing = []
    # EVERY package module, not a list of four. The list named `houston/web/app.py`,
    # and phase 2a moved the GUI's TLS handler into `houston/web/routes/repros.py` --
    # where this walk would no longer have looked, and would have gone on passing while
    # covering less. A walk that can be de-pointed by a file move is not a walk.
    root = pathlib.Path(__file__).resolve().parent.parent
    for rel in sorted(p.relative_to(root) for p in (root / "houston").rglob("*.py")):
        tree = ast.parse((root / rel).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                    and node.value.id in mods and not hasattr(mods[node.value.id], node.attr)):
                missing.append(f"{rel}:{node.lineno} {node.value.id}.{node.attr}")
    assert not missing, "attribute(s) that no longer exist: " + ", ".join(missing)


def test_dns01_provider_inference_is_not_cloudflare_specific(tmp_path, monkeypatch):
    from houston import tls
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    for body, expected in (("CF_DNS_API_TOKEN=x\n", "cloudflare"),
                           ("AWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=y\n", "route53"),
                           ("DO_AUTH_TOKEN=x\n", "digitalocean"),
                           ("HETZNER_API_KEY=x\n", "hetzner"),
                           ("AZURE_CLIENT_ID=x\n", "azuredns")):
        _dns_env(tmp_path, body)
        provider, why = tls.infer_dns_provider()
        assert provider == expected, f"{body!r} -> {provider!r}"
        assert "secret" not in why and "=" not in why, "never echo a credential VALUE"


def test_dns01_is_still_chosen_from_credentials_not_a_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import tls
    from houston.services import edge as edgesvc
    from houston.services import lifecycle as lcsvc

    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    tls.dns_env_path().write_text("CF_DNS_API_TOKEN=secret\n")
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    req = lcsvc.CreateReq(version="8.5.1", domain="chat.example.com",
                          acme_email="me@example.com")
    spec = lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert spec.acme_challenge == "dns" and spec.acme_dns_provider == "cloudflare"


def test_a_domain_on_kubernetes_plans_an_acme_issuer(monkeypatch):
    """`--https` and `--domain` are the same code path with a different ClusterIssuer,
    which is what the official values.yaml already implies -- the ingress block is
    byte-identical and only the annotation's value differs.

    Staging gets its own issuer NAME rather than a flag on one issuer:
    `privateKeySecretRef` holds the ACME ACCOUNT KEY, and pointing a production order
    at a staging account fails in a way that names neither. `tls.py` separates its
    storage file for the same reason.
    """
    from houston import tls as tlsmod
    from houston.services import k8s

    plan = _kube_tls_env(monkeypatch)
    spec = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1",
                                                domain="a.example.com"), spec, plan)
    assert ktls.issuer.mode == "acme"
    assert ktls.issuer.name == k8s.ACME_ISSUER
    assert ktls.issuer.directory == k8s.ACME_PRODUCTION
    assert ktls.issuer.acme_email == "ops@example.com"

    staging = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                             acme_email="ops@example.com", acme_staging=True)
    st = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1",
                                              domain="a.example.com"), staging, plan)
    assert st.issuer.name == k8s.ACME_ISSUER_STAGING, "a separate ACME account"
    assert st.issuer.directory == k8s.ACME_STAGING


def test_a_domain_needs_no_local_cluster_because_no_ca_key_leaves_the_box(monkeypatch):
    """The asymmetry that makes `--domain` the answer `--https`'s refusal points at.

    A `ca` issuer holds houston's CA private key, which can mint a certificate for
    any name this box trusts -- so it does not go into somebody else's cluster. An
    ACME issuer holds a Let's Encrypt ACCOUNT key, which is the cluster's own and
    mints nothing here. So a managed cluster refuses `--https` and accepts `--domain`.
    """
    from houston import tls as tlsmod

    plan = _kube_tls_env(monkeypatch, distribution="eks")
    with pytest.raises(errors.AuthorityGateError):
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1",
                                                domain="a.example.com"), acme, plan)
    assert ktls.issuer.mode == "acme", "the same cluster is fine for a public name"


def test_publishing_a_kubernetes_name_checks_it_instead_of_claiming_it(monkeypatch):
    """Measured on a box in exactly this state: the edge was bound, running, healthy,
    and answering every https name with its OWN default certificate, because the
    cluster had taken :443 underneath it. Nothing said so.

    `tls.verify` already reports that as `fallback`, so the proof is one existing call
    -- and a name that does not work has to say so at create time rather than be
    discovered in a browser.
    """
    from houston import tls as tlsmod
    from houston.services import edge as edgesvc
    from houston.services import k8s

    monkeypatch.setattr(edgesvc.spec, "installed", lambda: True)
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    monkeypatch.setattr(edgesvc.routes, "register", lambda *a, **kw: False)
    ktls = lc._KubeTls(host="ws.houston.localhost", ingress_class="traefik",
                       endpoint=k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                                    "kube-system/traefik", True),
                       cluster_owns_443=True)
    said: list[str] = []
    emit = lambda ev: said.append(f"{ev.level}:{ev.message}")  # noqa: E731

    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: {
        "serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT"})
    lc._publish_kubernetes_name("ws", ktls, emit=emit, sleep=lambda s: None)
    joined = "\n".join(said)
    assert "warn:" in joined and "default certificate" in joined, joined
    assert "terminating TLS for this name" in joined, joined

    said.clear()
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: {
        "serving": True, "fallback": False, "issuer": "CN = houston local CA"})
    lc._publish_kubernetes_name("ws", ktls, emit=emit, sleep=lambda s: None)
    assert any("is serving the cluster's certificate" in s for s in said), said


def test_a_public_name_create_says_nothing_about_credentials(monkeypatch):
    """The warning that used to fire here is GONE, deliberately, and this is what
    replaced it.

    It said the name was reachable, that the password was generated rather than
    admin123, where to read it, and to `down --volumes` when finished -- next to a
    summary panel that prints the URL and `admin / <the password>` two lines later.
    Every clause was either already on screen or a generic reminder, and a warning
    people scroll past is worse than no warning: it trains them to scroll past the
    next one.

    What made the original necessary was that a public name ran the SAME `admin123`
    as every loopback workspace and nothing said so. That is no longer true --
    `reachable_beyond_loopback` generates a password for exactly these workspaces --
    so the condition the sentence existed to report does not occur any more.
    """
    from houston import tls as tlsmod

    plan = _kube_tls_env(monkeypatch)
    said: list[str] = []
    emit = lambda ev: said.append(f"{ev.level}:{ev.message}")  # noqa: E731
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", name="pub",
                                         domain="a.example.com"), acme, plan,
                            emit=emit)
    joined = "\n".join(said)
    for gone in ("reachable by anyone who can resolve it", "admin password is GENERATED",
                 "admin123", "username as their password", "--volumes when you are"):
        assert gone not in joined, f"{gone!r} is still being said:\n{joined}"
    # The TLS progress it does still report is untouched -- removing a credentials
    # warning must not take the http-01 explanation with it.
    assert "http-01 challenge" in joined, joined


def test_a_public_name_still_gets_a_password_of_its_own(monkeypatch):
    """The property the warning used to announce. Removing the sentence must not be
    read, later, as removing the behaviour -- so it is asserted where the sentence
    used to be tested."""
    from houston import tls as tlsmod

    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    assert lc.reachable_beyond_loopback(tlsspec=acme, bind_host="127.0.0.1")


def test_a_public_name_gets_a_password_of_its_own(monkeypatch):
    """THE DEFECT. A name anybody on the internet can resolve was created running
    the same `admin123` every loopback workspace runs."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    monkeypatch.setattr(lc.tlsplan, "_resolve_tls", lambda req, name, bind, **k:
                        tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com",
                                       port=443, acme_email="ops@example.com"))
    _pin_edge(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="pub", wait=False,
                                 domain="a.example.com", acme_email="ops@example.com"),
                    emit=lc.null_emit)
    pw = seen["meta"].admin_password
    assert pw and pw != config.ADMIN_PASSWORD, f"still the shared one: {pw!r}"
    assert len(pw) >= 20, f"120 bits through token_urlsafe is 20 chars, got {pw!r}"
    assert seen["meta"].admin_pass == pw


def test_the_compose_document_provisions_the_password_that_was_recorded(monkeypatch):
    """The one invariant that makes the rest true. The compose document is what
    actually creates the admin, so a password written to repro.json and not to
    ADMIN_PASS would be a stored credential for a login that does not exist -- and
    every command reads the record, so ALL of them would 401 against a workspace
    whose real password is `admin123`."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    monkeypatch.setattr(lc.tlsplan, "_resolve_tls", lambda req, name, bind, **k:
                        tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="b.example.com",
                                       port=443, acme_email="ops@example.com"))
    _pin_edge(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="pair", wait=False,
                                 domain="b.example.com", acme_email="ops@example.com"),
                    emit=lc.null_emit)
    pw = seen["meta"].admin_password
    assert pw
    assert f"ADMIN_PASS: {pw}" in seen["yaml"] or pw in seen["yaml"], \
        "the record and the compose document disagree about the admin password"
    assert "admin123" not in seen["yaml"], "the old one must not also be in there"


def test_two_public_workspaces_do_not_share_a_password(monkeypatch):
    """Per WORKSPACE. One password for every public workspace on the box would make
    a single leak the whole box, which is the property being bought here."""
    from houston import config, tls as tlsmod  # noqa: F401
    made = []
    for i, host in enumerate(("c1.example.com", "c2.example.com")):
        seen = _capture_create(monkeypatch)
        monkeypatch.setattr(lc.tlsplan, "_resolve_tls", lambda req, name, bind, _h=host, **k:
                            tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host=_h, port=443,
                                           acme_email="ops@example.com"))
        _pin_edge(monkeypatch)
        lc.create_repro(lc.CreateReq(version="8.5.1", name=f"multi{i}", wait=False,
                                     domain=host, acme_email="ops@example.com"),
                        emit=lc.null_emit)
        made.append(seen["meta"].admin_password)
    assert made[0] and made[1] and made[0] != made[1]


def test_tls_root_url_omits_an_implicit_443():
    """A real domain answers on 443, so the URL must not carry it.

    RC advertises ROOT_URL verbatim; "https://host:443" in an OAuth callback or a
    mobile workspace URL is a mismatch against the same host without the port.
    """
    from houston import tls
    assert _tls_spec(port=8443).root_url == "https://x.houston.localhost:8443"
    assert _tls_spec(mode=tls.MODE_ACME, host="rc1.example.com", port=443).root_url \
        == "https://rc1.example.com"


def test_acme_storage_is_shared_with_workspaces():
    """§6: existing certificates are reused, so only NEW names cost against the
    50-per-domain-per-week limit. A private store would re-request every name."""
    from houston import tls

    vols = _doc()["services"]["edge"]["volumes"]
    assert any(v.startswith(f"{tls.acme_dir()}:") for v in vols)


def test_the_rewritten_acme_store_is_still_0600(tmp_path):
    """It is a file full of private keys. `atomic_write` would create it 0644 from
    the umask, which is how a fix for one exposure becomes another."""
    import stat

    from houston import tls
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    fd.delete_host("gone.example.org", confirm=True, restart=False)
    mode = (tls.acme_dir() / tls.ACME_FILE).stat().st_mode
    assert stat.S_IMODE(mode) == 0o600, oct(stat.S_IMODE(mode))


def test_a_garbage_acme_store_is_not_an_exception(tmp_path):
    """A half-written or hand-edited store means "no certificate for that host in
    here", which is the only question being asked of it."""
    from houston import tls
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    (tls.acme_dir() / tls.ACME_FILE).write_text("{not json", encoding="utf-8")
    assert fd.acme_hosts() == []
    assert fd.delete_host("x.example.org", confirm=True, restart=False)["acme"] == []


def test_the_issuance_ledger_is_kept(tmp_path):
    """`acme/issued.json` is the rate-limit history `tls-status` counts against
    Let's Encrypt's five-a-week duplicate limit. Deleting a certificate does not
    give the budget back, so erasing the record would make the count LIE."""
    from houston import tls
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    tls.record_issuance("gone.example.org")
    _write_acme()
    gone = fd.delete_host("gone.example.org", confirm=True, restart=False)
    assert gone["kept"] == ["acme/issued.json"]
    assert tls.recent_issuances("example.org") == 1
