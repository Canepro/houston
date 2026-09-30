"""`houston.tls_local`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations


def test_local_ca_is_created_once_and_leaf_carries_the_right_sans(monkeypatch, tmp_path):
    """The CA is reused, and the leaf gets SANs -- not just a CN.

    Browsers have ignored commonName since Chrome 58, so a cert with only a CN is
    rejected outright (ERR_CERT_COMMON_NAME_INVALID).
    """
    import subprocess
    from houston import tls_local
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    key, crt = tls_local.ensure_ca()
    assert key.exists() and crt.exists()
    assert oct(key.stat().st_mode)[-3:] == "600", "the CA key must not be world-readable"
    before = crt.read_bytes()
    assert tls_local.ensure_ca() == (key, crt)
    assert crt.read_bytes() == before, "ensure_ca must not regenerate an existing CA"

    cert_pem, key_pem = tls_local.issue_leaf("x.houston.localhost")
    assert "BEGIN CERTIFICATE" in cert_pem and "PRIVATE KEY" in key_pem
    leaf = tmp_path / "leaf.crt"
    leaf.write_text(cert_pem, encoding="utf-8")
    text = subprocess.run(["openssl", "x509", "-in", str(leaf), "-noout", "-text"],
                          capture_output=True, text=True).stdout
    assert "DNS:x.houston.localhost" in text
    assert "DNS:localhost" in text            # keeps the existing http habits working
    assert "IP Address:127.0.0.1" in text
    # And it must actually chain to the CA, not merely parse.
    v = subprocess.run(["openssl", "verify", "-CAfile", str(crt), str(leaf)],
                       capture_output=True, text=True)
    assert v.returncode == 0, v.stdout + v.stderr


def _a_real_tls_endpoint_and_its_ca(monkeypatch, tmp_path):
    """A local CA, a certificate it signed, and a socket actually serving it."""
    import socket as _socket
    import ssl
    import threading
    from houston import tls
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    from houston import tls_local
    _, ca_crt = tls_local.ensure_ca()
    cert_pem, key_pem = tls_local.issue_leaf("localhost")
    cf, kf = tmp_path / "s.crt", tmp_path / "s.key"
    cf.write_text(cert_pem, encoding="utf-8")
    kf.write_text(key_pem, encoding="utf-8")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cf), str(kf))
    srv = _socket.socket()
    srv.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    srv.listen(5)
    stop = threading.Event()

    def serve():
        srv.settimeout(0.5)
        while not stop.is_set():
            try:
                c, _ = srv.accept()
            except (TimeoutError, OSError):
                continue
            try:
                with ctx.wrap_socket(c, server_side=True):
                    pass
            except OSError:
                pass
            finally:
                c.close()

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return ca_crt, port, srv, stop, t, tls


def test_verify_reads_a_real_endpoint_and_separates_the_two_trust_questions(tmp_path, monkeypatch):
    """verify() must report an untrusted-but-working endpoint as working.

    Staging and local-CA certs are untrusted by design; refusing to look at them
    would report "broken" for a setup behaving exactly as intended. And `trusted`
    (system store) must stay distinct from `trusted_via_ca` (chains to a given CA),
    else local mode always claims trust and hides whether trust-ca has run.
    """
    ca_crt, port, srv, stop, t, tls = _a_real_tls_endpoint_and_its_ca(monkeypatch, tmp_path)
    try:
        r = tls.verify("localhost", port, timeout=5, cafile=str(ca_crt))
        assert r["serving"] is True and not r["error"]
        assert "houston local CA" in r["issuer"]
        assert "localhost" in r["subject"]
        assert r["fallback"] is False
        assert r["trusted_via_ca"] is True, "must chain to the CA it was handed"
        assert r["trusted"] is False, "the system store does not know this CA"
    finally:
        stop.set()
        srv.close()
        t.join(timeout=3)

    # Nothing listening -> reported, not raised.
    dead = tls.verify("127.0.0.1", port, timeout=2, cafile=str(ca_crt))
    assert dead["serving"] is False and dead["error"]


def test_verifying_tls_never_raises_when_the_ca_file_is_absent(tmp_path):
    """It is a REPORT, and it crashed its caller.

    `create_default_context(cafile=...)` raises FileNotFoundError for a CA that is not
    there -- an OSError, but raised one line above the handler that catches OSError. So
    a box that has only ever used `--domain` (and therefore never minted a local
    certificate, so `ca/ca.crt` does not exist) got a traceback out of the function
    whose entire job is to say what is being served.

    Found live, after the workspace had been built and its certificate issued: `up`
    ended in a Python traceback about a missing file.
    """
    from houston import tls as tlsmod

    import socket
    import ssl
    import threading

    from houston import tls_local

    # A REAL TLS server, because the bug is only reachable once the handshake has
    # succeeded: `verify` returns early when nothing answers, so pointing it at a dead
    # port exercises none of this and would pass whether the fix were there or not.
    crt, key = tls_local.issue_leaf("localhost")
    cert_f, key_f = tmp_path / "s.crt", tmp_path / "s.key"
    cert_f.write_text(crt)
    key_f.write_text(key)
    srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    srv_ctx.load_cert_chain(str(cert_f), str(key_f))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    port = sock.getsockname()[1]
    stop = threading.Event()

    def serve():
        sock.settimeout(0.5)
        while not stop.is_set():
            try:
                conn, _ = sock.accept()
            except (OSError, TimeoutError):
                continue
            try:
                with srv_ctx.wrap_socket(conn, server_side=True):
                    pass
            except (OSError, ssl.SSLError):
                pass

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    try:
        missing = str(tmp_path / "nope" / "ca.crt")
        r = tlsmod.verify("127.0.0.1", port, timeout=3.0, cafile=missing)
        assert r["serving"] is True, r          # the handshake really happened
        assert r["trusted_via_ca"] is False     # and the absent CA is an answer
    finally:
        stop.set()
        sock.close()
        t.join(timeout=3)
