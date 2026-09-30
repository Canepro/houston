"""`houston.services.edge.types`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import edge as fd


def test_the_staging_switch_actually_reaches_the_edge(tmp_path, monkeypatch):
    """`acme.staging` existed everywhere except where it mattered. The field was on the
    spec, `tls.py` built the staging CA URL from it, `config set acme.staging true`
    mapped to it, and staging even had its own storage file so switching could never mix
    a staging certificate into the production store -- and nothing wired it to the EDGE.
    `serve --domain` called `Edge.resolve` without it, so the switch was unreachable for
    the one component that requests certificates.

    It matters on a rate-limited box: Let's Encrypt allows five FAILED authorizations per
    name per hour, a support server has a name per ticket, and every restart abandons an
    in-flight challenge -- so a handful of restarts spends the hour's budget and staging
    is the only safe way left to test the plumbing."""
    from houston import config as cfgmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    cfgmod.save_config({"acme_staging": True})
    door = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert door.acme_staging is True

    args = fd.compose_doc(door)["services"]["edge"]["command"]
    assert any("acme-staging-v02.api.letsencrypt.org" in a for a in args), args
    # A SEPARATE store, so flipping back to production cannot serve a staging cert.
    assert any("acme-staging.json" in a for a in args), args

    # And production stays production when the switch is off.
    cfgmod.save_config({})
    prod = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert prod.acme_staging is False
    prod_args = fd.compose_doc(prod)["services"]["edge"]["command"]
    assert not any("acme-staging" in a for a in prod_args), prod_args

    # An explicit value still wins over the config, for a caller that knows.
    forced = fd.Edge.resolve("gui.example.test", "a@b.test", acme_staging=True)
    assert forced.acme_staging is True


def test_the_challenge_flags_come_from_the_workspace_code_path():
    """One implementation, so the two cannot drift on the thing that decides
    whether issuance works at all."""
    from houston import tls

    door = fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com")
    cmd = fd.compose_doc(door)["services"]["edge"]["command"]
    assert all(a in cmd for a in tls.acme_args(door.as_tls_spec()))
    assert "--certificatesresolvers.le.acme.email=ops@xyz.com" in cmd


def test_http_01_is_selectable_and_frees_the_challenge_path(tmp_path, monkeypatch):
    """houston offered exactly two challenges, derived and never asked for: dns-01 when
    credentials exist, TLS-ALPN otherwise. A real box had NEITHER available -- TLS-ALPN
    validation failed on every attempt with `remote error: tls: unrecognized name`, and
    dns-01 was impossible because the operator had the machine and not the DNS zone. With
    only host access and :80 open, http-01 was the one remaining option and there was no
    way to select it.

    Selecting it must also turn the :80 redirect OFF. An entryPoint redirection is a
    middleware on the entrypoint applied to every router on it -- measured: an explicit
    router for `/.well-known/acme-challenge/` on `web` still answered 301 -- so leaving
    it on would redirect Let's Encrypt away from the challenge it came to fetch."""
    from houston import config as cfgmod
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    cfgmod.save_config({"acme_challenge": "http"})
    door = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert door.acme_challenge == "http"
    args = fd.compose_doc(door)["services"]["edge"]["command"]
    assert "--certificatesresolvers.le.acme.httpchallenge=true" in args, args
    assert "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web" in args, args
    assert not any("tlschallenge" in a for a in args), args
    # THE POINT: :80 must stay available for the challenge.
    assert not any("redirections" in a for a in args), args

    # The default is unchanged -- TLS-ALPN with the redirect, exactly as before.
    cfgmod.save_config({})
    plain = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert plain.acme_challenge == "tlsalpn"
    pargs = fd.compose_doc(plain)["services"]["edge"]["command"]
    assert any("tlschallenge" in a for a in pargs), pargs
    assert sum("redirections" in a for a in pargs) == 3, pargs

    # A value nobody recognises falls back to the derivation rather than being passed
    # through to Traefik, where it would be a startup failure.
    cfgmod.save_config({"acme_challenge": "banana"})
    assert fd.Edge.resolve("g.example.test", "a@b.test").acme_challenge == "tlsalpn"


def test_the_edge_logs_at_info_so_acme_is_visible(tmp_path, monkeypatch):
    """Traefik's default log level is ERROR, and houston set none -- so a Traefik that
    is healthy but has NOT yet obtained a certificate logged nothing at all. That is
    exactly the state people get stuck in: the name serves Traefik's own default
    certificate, `docker logs` comes back empty, and an empty log reads as "nothing is
    wrong" when it means "nothing has failed YET".

    Measured on two boxes on the same day. The one with a real DNS failure had nine ERR
    lines and no INF lines; the one mid-issuance had an empty log and a default
    certificate. Diagnosis needs the second one to talk."""
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    args = fd.compose_doc(fd.Edge.resolve("g.example.test", "a@b.test"))["services"]["edge"]["command"]
    assert "--log.level=INFO" in args, args
    # Before the file provider, so a provider that cannot start says so.
    assert args.index("--log.level=INFO") < next(
        i for i, a in enumerate(args) if "providers.file" in a), args
    # A bare edge -- no domain, no ACME -- gets it too: `up --https` fails the same way.
    bare = fd.compose_doc(fd.Edge())["services"]["edge"]["command"]
    assert "--log.level=INFO" in bare, bare
