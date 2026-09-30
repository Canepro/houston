"""spec -- see the package docstring."""
from __future__ import annotations

import dataclasses
import json
from dataclasses import asdict
from houston import runner, tls

from houston.services.edge import engine
from houston.services.edge import paths
from houston.services.edge import routeyml
from houston.services.edge.paths import CONTAINER, DYNAMIC_DIR, SPEC_FILE
from houston.services.edge.types import Edge

def installed() -> bool:
    return paths.compose_path().is_file()

def served_domain() -> str:
    """The hostname the edge was set up with, or "".

    Recorded at write() so other code paths can NAME it -- the port-443 error is
    far more useful saying "held by the edge, which serves support.xyz.com"
    than "held by something". Read back from disk rather than passed around,
    because the code that needs it (`up`) is a different process from the one that
    set it up (`serve`).
    """
    try:
        return (paths.edge_dir() / "domain").read_text().strip()
    except OSError:
        return ""

def _traefik_command(fd):
    """Every flag Traefik is started with, and why each one is there."""
    cmd = [
        # A DIRECTORY, not a single file: this is what makes registration a matter
        # of writing one file per workspace, with no restart. Verified live -- a
        # second workspace was routed with the container's restart count at 0.
        # INFO, not Traefik's default of ERROR. At ERROR a Traefik that is healthy but
        # has not yet obtained a certificate logs NOTHING -- and that is exactly the
        # state people get stuck in: the name serves Traefik's own default certificate,
        # `docker logs` comes back empty, and an empty log reads as "no problem" when it
        # means "no error YET". Measured on two boxes on the same day: the one with a
        # real DNS failure had nine ERR lines and the one mid-issuance had none at all,
        # which is exactly the wrong way round for diagnosis. INFO makes the ACME
        # provider starting, each order and each challenge visible -- which is the
        # question anybody reading this log actually has.
        "--log.level=INFO",
        f"--providers.file.directory=/etc/traefik/{DYNAMIC_DIR}",
        "--providers.file.watch=true",
        # Container-internal ports, always 80/443 -- fd.http_port/https_port map
        # onto these from the host side, in `ports` below.
        "--entryPoints.websecure.address=:443",
        "--entryPoints.web.address=:80",
        # Typing the bare hostname reaches nothing otherwise: browsers try http
        # first. Same redirect the official rocketchat-compose Traefik files use.
        # ...and :80 redirected to it, EXCEPT under http-01. An entryPoint redirection
        # is a middleware on the entrypoint applied to every router on it -- measured:
        # an explicit router for `/.well-known/acme-challenge/` on `web` still answered
        # 301 -- so leaving it on would redirect Let's Encrypt away from the challenge it
        # came to fetch. The cost is stated rather than hidden: while http-01 is in use,
        # an `http://` URL does not upgrade itself.
        *([] if fd.acme_challenge == "http" else [
            "--entryPoints.web.http.redirections.entryPoint.to=websecure",
            "--entryPoints.web.http.redirections.entryPoint.scheme=https",
            "--entryPoints.web.http.redirections.entryPoint.permanent=true",
        ]),
    ]
    # Only with an email to register the ACME account against. Without one the
    # edge still serves every LOCAL-CA name perfectly well -- which is what lets
    # `up --https` start it with no configuration at all, on a box that has no
    # public domain and never will. A resolver declared with no email makes
    # Traefik fail at startup, so this is a real branch, not tidiness.
    if fd.acme_email:
        cmd += tls.acme_args(fd.as_tls_spec())
    return cmd


def compose_doc(fd: Edge) -> dict:
    """The edge's compose document. Pure -- no disk, no Docker."""
    cmd = _traefik_command(fd)

    svc: dict = {
        "image": f"docker.io/traefik:{tls.TRAEFIK_TAG}",
        # The GUI and every workspace are unreachable while this is down (§8).
        "restart": "unless-stopped",
        "command": cmd,
        "volumes": [
            f"./{DYNAMIC_DIR}:/etc/traefik/{DYNAMIC_DIR}:ro",
            # Locally-signed certificates, for `--https` names. Without this mount
            # the declaration issue_local_cert() writes points at a path that does
            # not exist inside the container, and Traefik quietly serves its own
            # default certificate instead -- which looks exactly like a working
            # setup until you read the issuer.
            "./certs:/etc/traefik/certs:ro",
            # Shared with workspaces, so a certificate already issued for a name
            # is reused rather than re-requested against the weekly limit (§6).
            f"{tls.acme_dir()}:/etc/traefik/acme",
        ],
        "ports": [f"{fd.http_port}:80", f"{fd.https_port}:443"],
        # No `networks` key at all. It joins each workspace's own network at
        # runtime; naming one here made compose refuse the project outright
        # ("service edge refers to undefined network edge") once the shared
        # network was removed from the document.
        # How this container reaches the GUI, which is a HOST process (uvicorn),
        # not a container -- so it is not on the edge network and cannot be
        # reached by name. host-gateway resolves to the bridge address.
        "extra_hosts": ["host.docker.internal:host-gateway"],
    }
    if fd.acme_challenge == "dns":
        svc["env_file"] = [str(tls.dns_env_path())]

    # No `networks:` block. The edge joins each workspace's OWN network at
    # runtime, with `docker network connect`, so there is nothing to declare here
    # -- and declaring a shared one is exactly what would have put every workspace
    # on the same network and let them reach each other.
    return {"services": {"edge": svc}}

# --- disk ---------------------------------------------------------------------

def write(fd: Edge) -> None:
    """Materialise `<home>/edge/` -- compose file and the watched directory."""
    from houston import compose as compose_mod

    paths.dynamic_dir().mkdir(parents=True, exist_ok=True)
    # Before compose mounts it: a bind-mount source that does not exist is created
    # by Docker, owned by root, and then houston cannot write certificates into it.
    paths.certs_dir().mkdir(parents=True, exist_ok=True)
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    runner.atomic_write(paths.compose_path(), compose_mod.to_yaml(compose_doc(fd)))
    runner.atomic_write(paths.edge_dir() / "domain", fd.domain + "\n")
    # THE WHOLE SPEC, because `current()` could only reconstruct the domain and the
    # wildcard flag -- it silently dropped the email, the GUI host and the GUI port, so
    # nothing but `serve --domain` could rebuild this edge faithfully. That is why
    # `houston edge start` could not apply a changed `acme.challenge`: it had no way to
    # regenerate the compose file without losing where the GUI lives.
    runner.atomic_write(paths.edge_dir() / SPEC_FILE, json.dumps(asdict(fd), indent=2))
    # ONLY with a domain. A bare edge (started by `up --https` on a box that has
    # no public name) has nothing to route to the GUI, and writing the route
    # anyway produced `Host(``)` -- which Traefik rejects at load with "empty args
    # for matcher Host", and then names a certResolver that a bare edge does not
    # declare either. Two errors on every start, for a route that cannot work.
    if fd.domain:
        runner.atomic_write(paths.route_path("_gui"), routeyml.gui_route_yml(fd))
    else:
        paths.route_path("_gui").unlink(missing_ok=True)

def current() -> "Edge | None":
    """The edge as it was set up, or None. Read back from disk because `up`
    is a different process from the `serve` that configured it.

    Prefers the recorded spec. The fallback below is what this used to be, and it is
    kept for an edge written by a version that did not record one -- it reconstructs the
    domain and infers the wildcard, and loses the email, the GUI host and the GUI port,
    which is exactly why rebuilding from it was unsafe.
    """
    if not installed():
        return None
    spec = paths.edge_dir() / SPEC_FILE
    if spec.is_file():
        try:
            data = json.loads(spec.read_text(encoding="utf-8"))
            fields = {f.name for f in dataclasses.fields(Edge)}
            return Edge(**{k: v for k, v in data.items() if k in fields})
        except (OSError, ValueError, TypeError):
            pass                       # fall through rather than fail a start
    domain = served_domain()
    from houston import tls as tlsmod
    return Edge(domain=domain, wildcard=bool(domain and tlsmod.dns_env_vars()))

def config_drift() -> tuple[list[str], list[str]]:
    """`(only in the compose file, only in the running container)` for the edge's flags.

    RUNNING IS NOT UP TO DATE, which cost two days once: `config set acme.challenge
    http` rewrote the compose file, the container kept the command line it was created
    with, and every message said the edge was fine. `edge start` re-applies now, but
    nothing SAID when the two had diverged -- and a reader who has just changed a
    setting has no way to tell whether it took.

    Empty lists when they agree, or when there is nothing to compare (no edge, not
    running, no compose file). Compared as flag lists rather than by order: compose
    and docker do not have to agree about ordering for the configuration to be
    identical.
    """
    if not installed() or not engine.running():
        return [], []
    try:
        import yaml

        doc = yaml.safe_load(paths.compose_path().read_text(encoding="utf-8")) or {}
        svc = next(iter((doc.get("services") or {}).values()), {}) or {}
        want = [str(a) for a in (svc.get("command") or [])]
    except (OSError, ValueError, yaml.YAMLError):
        return [], []
    out = engine._docker("inspect", CONTAINER, "--format", "{{json .Config.Cmd}}")
    if out.returncode != 0:
        return [], []
    try:
        got = [str(a) for a in (json.loads(out.stdout or "null") or [])]
    except ValueError:
        return [], []
    if not want or not got:
        return [], []
    return ([f for f in want if f not in got], [f for f in got if f not in want])
