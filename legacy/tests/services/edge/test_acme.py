"""`houston.services.edge.acme`: its own spec file.

Co-located out of `tests/test_edge.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from edgehelpers import _write_acme
from houston.services import edge as fd


def test_a_teardown_leaves_the_certificate_and_its_private_key(tmp_path):
    """THE DEFECT, stated as the thing that survives.

    `deregister` is what teardown calls and it unlinks `dynamic/<name>.yml`. The
    certificate, its key and the declaration that loads them are named after the
    HOST, so all three walk straight past it -- and `orphan_certs` reports nothing,
    because it flags a declaration whose certificate is MISSING and here everything
    is present, valid, and unreachable. The visible symptom is a TLS handshake that
    succeeds, with a genuine certificate for the name, into a 404.
    """
    host = "t-1234.houston.localhost"
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("t-1234", host, local=True)
    fd.issue_local_cert(host)
    _write_acme(doc={"le": {"Certificates": [
        {"domain": {"main": host, "sans": []}, "certificate": "c", "key": "k"}]}})

    fd.deregister("t-1234")                      # exactly what `down --volumes` calls

    assert (fd.certs_dir() / f"{host}.crt").is_file()
    assert (fd.certs_dir() / f"{host}.key").is_file()
    assert (fd.dynamic_dir() / f"_cert-{host}.yml").is_file()
    assert fd.acme_hosts() == [host]
    assert fd.orphan_certs() == [], "the wrong direction: it finds MISSING certs"
