"""`houston.runner.paths`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from conftest import source_index
from conftest import source_of
from houston.services import edge as fd
import pytest


def test_a_private_key_is_never_written_at_the_umask():
    """`atomic_write` wrote at the umask, and `certs/<host>.key` went through it.

    So the edge's leaf key landed 0644 on a box where `~/.houston` is only tightened to
    0700 by `serve` or a config save -- neither of which runs on a CLI-only
    `up --https`. And the local CA key is created by `openssl genrsa -out`, which makes
    the file at 0666 & ~umask with the chmod landing after it: a real, if brief,
    world-readable key that can mint a certificate for any name the browser trusts.
    """
    import tempfile
    from pathlib import Path

    from houston import runner
    from houston.services import edge as edgesvc

    # The mode is applied to the TEMP file, so the target never exists at the umask
    # even for an instant.
    src = source_of(runner.atomic_write)
    assert "mode: int | None" in src
    assert source_index(src, "os.chmod(tmp, mode)") < source_index(src, "os.replace(tmp, path)"), src

    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "k.key"
        runner.atomic_write(target, "secret", mode=0o600)
        assert oct(target.stat().st_mode)[-3:] == "600", oct(target.stat().st_mode)

    # And the edge passes it for the key but not the certificate, which is public.
    esrc = source_of(edgesvc.issue_local_cert)
    assert 'f"{host}.key", key_pem, mode=0o600' in esrc, esrc[-400:]

    # The CA directory is created 0700 before the key is generated in it.
    from houston import tls_local
    csrc = source_of(tls_local)
    assert "mkdir(parents=True, exist_ok=True, mode=0o700)" in csrc


def test_delete_host_refuses_while_a_live_workspace_claims_the_name(tmp_path):
    """Deleting the certificate under a running workspace would leave one that
    cannot serve its own name. The workspace is NAMED, with the command."""
    from houston import runner
    from houston.errors import ConflictError

    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("live", "live.example.org", local=True)
    runner.workspace("live").mkdir(parents=True, exist_ok=True)
    (runner.workspace("live") / "repro.json").write_text("{}", encoding="utf-8")

    with pytest.raises(ConflictError) as exc:
        fd.delete_host("live.example.org", confirm=True, restart=False)
    assert "live" in str(exc.value)
    assert "down --name live --volumes" in str(exc.value)
    assert fd.route_path("live").exists(), "refused means nothing was touched"
