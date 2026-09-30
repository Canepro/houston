"""`houston.services.edge.paths`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from edgehelpers import _doc, _read_acme, _write_acme
from houston import config
from houston.services import edge as fd


def test_a_certificate_that_cannot_be_written_is_refused_not_declared(tmp_path, monkeypatch):
    """Docker creates a missing bind-mount target as ROOT, so on a box where the edge
    started before any local certificate was issued, `edge/certs` is root-owned while
    `edge/dynamic` is not. The declaration then landed and the certificate did not, and
    Traefik retried the pair for ever -- "failed to find any PEM data in certificate
    input", once a second, serving nothing for that name. Two such orphans were found on
    a live box."""
    import os
    from houston import errors
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.certs_dir().mkdir(parents=True, exist_ok=True)
    fd.dynamic_dir().mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(os, "access", lambda p, mode: False)

    try:
        fd.issue_local_cert("w.houston.localhost")
    except errors.ReproError as exc:
        assert "not writable" in str(exc), exc
        assert "chown" in str(exc), "give the fix, not just the fault"
    else:
        raise AssertionError("declared a name whose certificate could not be written")

    # And nothing was declared, so there is no permanent error loop to explain.
    assert not list(fd.dynamic_dir().glob("_cert-*.yml"))


def test_orphaned_declarations_are_reportable(tmp_path, monkeypatch):
    """The state above, once it exists: a declaration with no certificate. Silent apart
    from a log nobody was pointed at, so `edge status` has to be able to see it."""
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.certs_dir().mkdir(parents=True, exist_ok=True)
    fd.dynamic_dir().mkdir(parents=True, exist_ok=True)
    (fd.dynamic_dir() / "_cert-a.localhost.yml").write_text("tls: {}\n")
    (fd.dynamic_dir() / "_cert-b.localhost.yml").write_text("tls: {}\n")
    (fd.certs_dir() / "b.localhost.crt").write_text("-----BEGIN CERTIFICATE-----\n")
    (fd.certs_dir() / "a.localhost.crt").write_text("")        # empty is as bad as absent

    assert fd.orphan_certs() == ["a.localhost"]


def test_a_local_certificate_can_be_issued_before_any_edge_exists(tmp_path, monkeypatch):
    """The first `up --https` on a fresh box: nothing has created the watched
    directory yet, and atomic_write puts its temp file beside the target -- so a
    missing parent was a FileNotFoundError and `up --https` crashed outright.
    Found by running it, in an audit, not by any test."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert not fd.dynamic_dir().exists(), "precondition: no edge yet"

    fd.issue_local_cert("w.houston.localhost")
    assert (fd.certs_dir() / "w.houston.localhost.crt").is_file()
    decl = fd.dynamic_dir() / "_cert-w.houston.localhost.yml"
    assert decl.is_file() and "certFile:" in decl.read_text()


def test_the_project_name_cannot_collide_with_a_repro():
    """`down` on a repro named "edge" must not tear down the box's ingress.

    sanitize() maps everything outside [a-z0-9-] to "-", so no repro name can
    ever produce this project name -- but PROJECT_PREFIX + "edge" would.
    """
    from houston.services.lifecycle import sanitize

    assert "_" in fd.PROJECT
    assert fd.PROJECT != config.PROJECT_PREFIX + "edge"
    assert sanitize("edge_x") != "edge_x", "sanitize strips underscores"


# --- the compose document -------------------------------------------------------

def test_it_watches_a_directory_not_a_file():
    """Registration is "write one file"; a single --providers.file.filename would
    make it "rewrite the shared file", which cannot be done concurrently."""
    cmd = _doc()["services"]["edge"]["command"]
    assert f"--providers.file.directory=/etc/traefik/{fd.DYNAMIC_DIR}" in cmd
    assert "--providers.file.watch=true" in cmd
    assert not any(a.startswith("--providers.file.filename") for a in cmd)


def test_delete_host_removes_everything_a_teardown_left(tmp_path):
    host = "t-1234.houston.localhost"
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("t-1234", host, local=True)
    fd.issue_local_cert(host)
    _write_acme(doc={"le": {"Account": {"Email": "ops@xyz.com"}, "Certificates": [
        {"domain": {"main": host, "sans": []}, "certificate": "c", "key": "k"}]}})

    gone = fd.delete_host(host, confirm=True, restart=False)

    assert gone["host"] == host
    assert gone["routes"] == ["t-1234"]
    assert gone["certificate"] is True
    assert gone["declaration"] is True
    assert gone["acme"] == ["acme.json"]
    assert not (fd.certs_dir() / f"{host}.crt").exists()
    assert not (fd.certs_dir() / f"{host}.key").exists()
    assert not (fd.dynamic_dir() / f"_cert-{host}.yml").exists()
    assert not fd.route_path("t-1234").exists()
    assert fd.acme_hosts() == []
    # The ACCOUNT is a registration with Let's Encrypt, not a certificate. Dropping
    # it makes the next issuance register again for nothing.
    assert _read_acme()["le"]["Account"] == {"Email": "ops@xyz.com"}
