"""The edge: one Traefik holding :80/:443 for everything on the box.

A workspace never terminates TLS. The edge does, for all of them, and a workspace
gains or loses HTTPS by a ROUTE FILE appearing or disappearing -- not by being
rebuilt.

That is the whole point, and it is what the first version got wrong. There,
"does this workspace run its own Traefik" was baked into its compose file at
CREATE time, so changing the answer meant rewriting the file and recreating the
containers. Everything painful followed from that one misplaced decision: the
port-443 arbitration, two compose shapes, `--adopt`, an ordering trap where the
edge had to exist before a workspace was created to matter. Six mechanisms
compensating for one build-time choice.

Here TLS is a RUNTIME property:

* **Every workspace keeps its own network**, exactly as compose already gives it.
  No shared network, so workspaces still cannot reach each other -- verified: with
  the edge attached to both, w1 could reach w2 neither by name nor by IP, because
  a container does not forward between its interfaces.
* **The edge joins a workspace's network live**, with `docker network connect`,
  only when that workspace has a route. Verified against a running container:
  resolvable immediately, `StartedAt` unchanged -- no restart, no recreation.
* **Routes address the CONTAINER NAME**, never the service alias. Every workspace
  calls its service `rocketchat`, and from the edge -- attached to many networks
  that each contain one -- the bare name resolved 6/6 to the SAME workspace.
  Deterministic, not round-robin, which is worse: it looks stable under testing
  and would silently serve the wrong workspace forever.
* **Nothing is in the workspace's compose file about any of this.** Attachment is
  re-applied after a recreate rather than declared, which is what keeps one
  compose shape for every workspace, TLS or not.

Two properties carried over from the first version because they were right:

* **Invisible as a WORKSPACE, visible as infrastructure.** The compose project
  lives in `<home>/edge/`, outside `config.repros_dir()`, and `list`/`prune`/
  `down`/the GUI grid all enumerate that directory -- so none of them can touch
  it, for free. `rc-repro edge status` and `doctor` are where it answers for
  itself.
* **No Docker socket.** Routes arrive through Traefik's file provider watching a
  directory. Being files is also why routes survive the edge being removed, and a
  reboot.
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from rc_repro import config, runner, tls
from rc_repro.errors import ConflictError, ReproError, ValidationError

#: `<home>/edge` -- deliberately a sibling of `repros/`, never inside it.
EDGE_DIR = "edge"
#: Traefik watches this for one routing file per registered name.
DYNAMIC_DIR = "dynamic"
#: The Edge spec as written, so a later process can rebuild it exactly.
SPEC_FILE = "spec.json"

#: The compose project name. The underscore is load-bearing: `sanitize()` maps
#: every non `[a-z0-9-]` character to "-", so no repro can ever be named
#: `rcrepro_edge`, and the edge's project therefore cannot collide with a repro
#: literally named "edge" -- which WOULD collide under `PROJECT_PREFIX + name`,
#: and would let `down` on that repro tear down the box's only ingress.
PROJECT = "rcrepro_edge"
#: The edge's own container, as compose names it: <project>-<service>-<index>.
CONTAINER = f"{PROJECT}-edge-1"


def edge_dir() -> Path:
    return config.home() / EDGE_DIR


def dynamic_dir() -> Path:
    return edge_dir() / DYNAMIC_DIR


def compose_path() -> Path:
    return edge_dir() / "compose.yml"


def installed() -> bool:
    return compose_path().is_file()


def served_domain() -> str:
    """The hostname the edge was set up with, or "".

    Recorded at write() so other code paths can NAME it -- the port-443 error is
    far more useful saying "held by the edge, which serves support.xyz.com"
    than "held by something". Read back from disk rather than passed around,
    because the code that needs it (`up`) is a different process from the one that
    set it up (`serve`).
    """
    try:
        return (edge_dir() / "domain").read_text().strip()
    except OSError:
        return ""


def workspace_network(name: str) -> str:
    """The network compose creates for a workspace: `<project>_default`."""
    return f"{runner.project_name(name)}_default"


def backend_container(name: str, service: str) -> str:
    """The container compose creates for one of a workspace's services.

    A CONTAINER name, not a service alias, and that distinction is the whole
    reason routes work. The edge is attached to many workspace networks, each
    containing a service called `rocketchat`; asking for `rocketchat` from there
    resolved 6/6 to one particular workspace. Container names are unique across
    every network, so they cannot be confused.
    """
    return f"{runner.project_name(name)}-{service}-1"


def route_path(name: str) -> Path:
    return dynamic_dir() / f"{name}.yml"


@dataclass
class Edge:
    """What the edge serves. `domain` is the GUI's own hostname."""
    domain: str = ""
    acme_email: str = ""
    acme_staging: bool = False
    acme_challenge: str = "tlsalpn"
    acme_dns_provider: str = ""
    #: Where the GUI process listens. It binds the Docker bridge rather than
    #: loopback so this container can reach it and nothing else can -- verified
    #: reachable from a container and refused from 127.0.0.1.
    gui_host: str = ""
    gui_port: int = 7070
    #: Overridable so tests (and a box where 443 is genuinely taken) are not
    #: forced onto privileged ports.
    http_port: int = 80
    https_port: int = 443
    #: One `*.<domain>` certificate instead of one per workspace name (§3.5).
    #: Derived from whether DNS credentials exist, never asked for -- a wildcard
    #: can ONLY be issued over dns-01, so the token is the whole question.
    wildcard: bool = False

    @classmethod
    def resolve(cls, domain: str, acme_email: str, **kw) -> "Edge":
        """Build one, choosing the challenge the way the rest of the tool does.

        `acme.staging` is read here, and that is new: the field existed, `tls.py` built
        the staging CA URL from it, `config set acme.staging true` mapped to it and
        staging even got its own storage file so switching could never mix a staging
        certificate into the production store -- and NOTHING wired it to the edge.
        `serve --domain` called this without it, so the switch was unreachable for the
        one component that requests certificates.

        That mattered on the box that found it. Let's Encrypt allows five FAILED
        authorizations per name per hour, a support box has a name per ticket, and every
        restart abandons an in-flight challenge -- so a few restarts spend the budget for
        the whole hour and the only safe way to test the plumbing is against staging,
        which is what this switch is for.
        """
        from rc_repro import config as cfgmod
        from rc_repro import tls as tlsmod

        has_dns = bool(tlsmod.dns_env_vars())
        provider = tlsmod.infer_dns_provider()[0] if has_dns else ""
        cfg = cfgmod.load_config()
        # `truthy`, not `bool` -- "false" is a truthy string, which made the staging
        # switch one-way. Same fix as the workspace path; same reason.
        kw.setdefault("acme_staging", cfgmod.truthy(cfg.get("acme_staging")))
        # Derived, but overridable -- because the derivation assumes one of the two
        # automatic paths is available and a real box existed where neither was: TLS-ALPN
        # validation failed on every attempt and the operator had no access to the DNS
        # zone. `config set acme.challenge http` is the escape hatch for that, and it
        # names the mechanism rather than a symptom.
        forced = str(cfg.get("acme_challenge") or "").strip().lower()
        challenge = (forced if forced in ("http", "tlsalpn", "dns")
                     else ("dns" if has_dns else "tlsalpn"))
        return cls(domain=domain, acme_email=acme_email,
                   acme_challenge=challenge,
                   acme_dns_provider=provider,
                   wildcard=has_dns and challenge == "dns", **kw)

    def covers(self, host: str) -> bool:
        """Whether the wildcard already covers `host`, so it needs no request.

        Exactly one label below the domain: a TLS wildcard matches ONE label, and
        `a.b.support.xyz.com` is therefore not covered even though a DNS wildcard
        would resolve it -- the two wildcards match differently and conflating them
        would mean serving the wrong certificate.
        """
        if not (self.wildcard and self.domain and host):
            return False
        suffix = f".{self.domain}"
        return host.endswith(suffix) and "." not in host[:-len(suffix)]

    def as_tls_spec(self) -> tls.TlsSpec:
        """The equivalent workspace TlsSpec, so ACME flags come from one place."""
        return tls.TlsSpec(
            mode=tls.MODE_ACME, host=self.domain, port=self.https_port,
            acme_email=self.acme_email, acme_staging=self.acme_staging,
            acme_challenge=self.acme_challenge,
            acme_dns_provider=self.acme_dns_provider)


def compose_doc(fd: Edge) -> dict:
    """The edge's compose document. Pure -- no disk, no Docker."""
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


def gui_route_yml(fd: Edge) -> str:
    """The routing file for the GUI itself.

    When a wildcard is available this router is what asks for it -- one request
    covering the apex and every `*.domain` workspace, so no workspace ever costs
    a certificate again.
    """
    wildcard = f"*.{fd.domain}" if fd.wildcard else ""
    return _route_yml("gui", fd.domain, f"http://host.docker.internal:{fd.gui_port}",
                      sticky=False, wildcard=wildcard)


def certs_dir() -> Path:
    return edge_dir() / "certs"


def issue_local_cert(host: str) -> None:
    """Put a locally-signed certificate for `host` where the edge can serve it.

    This is what lets `--https` and `--domain` be the SAME path: they differ only
    in where the certificate comes from -- rc-repro's own CA, or Let's Encrypt --
    and both end up as one route on one port. Before, a local-CA workspace ran its
    own Traefik on an allocated port, so ten of them ate ten ports and each got a
    different URL; now every one of them answers on 443 by hostname.
    """
    from rc_repro import tls_local

    cert_pem, key_pem = tls_local.issue_leaf(host)
    certs_dir().mkdir(parents=True, exist_ok=True)
    # WRITABLE? Docker creates a bind-mount target that does not exist, and it creates
    # it as root -- so on a box where the edge started before any local certificate was
    # issued, `edge/certs` is root-owned while `edge/dynamic` is not. The declaration
    # then lands and the certificate does not, and Traefik retries the pair for ever:
    #
    #     Unable to append certificate /etc/traefik/certs/<host>.crt to store
    #     error="tls: failed to find any PEM data in certificate input"
    #
    # Observed on a live box with two such orphans, logging once a second and serving
    # nothing for either name. A PermissionError here used to surface as whatever the
    # caller did with it; it is a fixable environment fault and says so.
    if not os.access(certs_dir(), os.W_OK):
        raise ValidationError(
            f"cannot write certificates into {certs_dir()} — it is not writable by "
            f"this user, so the name would be declared and never served.\n"
            f"  Docker creates a missing bind-mount target as root. Give it back:\n"
            f"    sudo chown -R $(id -u):$(id -g) {certs_dir()}")
    # And the watched directory: this writes the certificate DECLARATION into it,
    # and on the first `up --https` of a box that has no edge yet, nothing has
    # created it. atomic_write puts its temp file beside the target, so a missing
    # parent is a FileNotFoundError -- `up --https` crashed outright.
    dynamic_dir().mkdir(parents=True, exist_ok=True)
    runner.atomic_write(certs_dir() / f"{host}.crt", cert_pem)
    # 0600 on the KEY, set on the temp file so the target never exists world-readable.
    # This landed at the umask (typically 0644) on a box whose `~/.rc-repro` is only
    # tightened to 0700 by `serve` or a config save -- neither of which runs on a
    # CLI-only `up --https`.
    runner.atomic_write(certs_dir() / f"{host}.key", key_pem, mode=0o600)
    # Checked, because the declaration written below is what makes an absent certificate
    # a permanent error loop rather than a missing file nobody references.
    for part in ("crt", "key"):
        if not (certs_dir() / f"{host}.{part}").stat().st_size:
            raise ValidationError(
                f"the {part} for {host} was written empty to {certs_dir()} — Traefik "
                f"would log 'failed to find any PEM data' for it for ever. Check the "
                f"space and permissions on that directory.")
    # Declared in the watched directory, so Traefik picks it up like any route.
    runner.atomic_write(
        dynamic_dir() / f"_cert-{host}.yml",
        "# Generated by rc-repro. Do not edit by hand.\n"
        "tls:\n"
        "  certificates:\n"
        f"    - certFile: /etc/traefik/certs/{host}.crt\n"
        f"      keyFile: /etc/traefik/certs/{host}.key\n")


def workspace_route_yml(name: str, host: str, instances: int = 1,
                        wildcard_base: str = "", local: bool = False) -> str:
    """The routing file a workspace registers: `host` -> its Rocket.Chat.

    `wildcard_base` is the edge's domain when its wildcard already covers `host`.
    The route then names that wildcard instead of the host, so Traefik serves the
    existing certificate rather than requesting a per-name one (§3.5).
    """
    from rc_repro import compose as compose_mod

    backends = [f"http://{backend_container(name, svc)}:{config.RC_CONTAINER_PORT}"
                for svc in compose_mod.rc_service_names(instances)]
    return _route_yml(name, host, *backends, local=local,
                      wildcard=f"*.{wildcard_base}" if wildcard_base else "")


#: `<address>:<port>`, the only shape a Traefik TCP server takes. Checked rather
#: than trusted: a bare address here loads as a router with no reachable server, so
#: the name answers nothing and Traefik says so only in its own log.
_ADDR_RE = re.compile(r"^[A-Za-z0-9._\[\]:-]+:\d{1,5}$")


def passthrough_route_yml(key: str, host: str, address: str) -> str:
    """A route that does NOT decrypt: match `host` by SNI, forward raw TCP.

    The second kind of backend, and the reason it exists is fidelity rather than
    convenience. A Kubernetes workspace's certificate lives in a cluster Secret and
    its Ingress is what terminates TLS -- so if the edge terminated instead, the
    `tls:` block, the Secret and cert-manager would never run, and those are exactly
    where a customer's certificate bugs live. Passing through means the bytes the
    browser exchanges with the ingress are the bytes it would exchange in production.

    `tcp` and `http` routers share the entrypoint deliberately: Traefik matches TCP
    routers by SNI FIRST and falls through to HTTP routers for anything unmatched,
    which is what lets one :443 terminate for a Compose name and pass through for a
    Kubernetes one. Measured on this box, one entrypoint, two names: the Compose name
    received the edge's own leaf and the Kubernetes name received the cluster's
    Secret, byte-identical to it -- and the response through the passthrough carried
    `X-Forwarded-Server: <the CLUSTER's traefik pod>` with the ORIGINAL port intact,
    so nothing here rewrote anything.

    No `certResolver` and no certificate of any kind: naming one would make the edge
    request a certificate for a name it is not serving, and the wildcard question
    (`Edge.covers`) does not arise either, because nothing here presents a
    certificate. That is why `register` returns False for this shape.
    """
    if not _ADDR_RE.match(address or ""):
        raise ValidationError(
            f"a passthrough backend needs `<address>:<port>`, not {address!r} — "
            f"Traefik would load the router with no reachable server and {host} "
            f"would answer nothing, with the reason only in the edge's own log.")
    return (
        "# Generated by rc-repro. Do not edit by hand.\n"
        "# A TCP passthrough: the edge does NOT decrypt this name.\n"
        "tcp:\n"
        "  routers:\n"
        f"    {key}:\n"
        f'      rule: "HostSNI(`{host}`)"\n'
        "      entryPoints: [websecure]\n"
        f"      service: {key}\n"
        "      tls:\n"
        "        passthrough: true\n"
        "  services:\n"
        f"    {key}:\n"
        "      loadBalancer:\n"
        "        servers:\n"
        f'          - address: "{address}"\n')


def route_reachable(name: str, attached: set[str] | list[str]) -> bool:
    """Whether the edge can actually deliver `name`'s route, given what it is attached to.

    TWO DIFFERENT QUESTIONS behind one column. An HTTP route is delivered over a
    Docker network the edge has joined, so membership is the test. A PASSTHROUGH
    route forwards raw TCP to an address -- a cluster NodePort -- and joins no
    workspace network at all, so membership is always False for it and the honest
    answer is not "unreachable".

    `/api/edge` learned this and `edge status` did not, so the CLI reported
    `NO (502)` for every Kubernetes workspace. Measured in production conditions: a
    workspace answering HTTP 200 from the internet on a real Let's Encrypt
    certificate, listed as unreachable by the command whose job is to say so. One
    implementation here because that is the second time these two front ends
    disagreed about the same route file.
    """
    if is_passthrough(name):
        return True
    return workspace_network(name) in set(attached)


def is_passthrough(name: str) -> bool:
    """Whether `name`'s route passes TLS through rather than terminating it.

    Read from the route FILE, and parsed rather than sniffed for a substring: the
    caller that needs it is `reattach_all` on the `edge start` path, which is looking
    at routes and may have no workspace record to consult -- a route outlives its
    workspace, which is the whole reason `deregister` exists.

    False for anything unreadable. The only consequence of being wrong here is an
    attach that was not needed, which is a no-op, so the safe answer is the one that
    behaves as this function's absence did.
    """
    import yaml

    try:
        doc = yaml.safe_load(route_path(name).read_text(encoding="utf-8"))
    except (OSError, ValueError, yaml.YAMLError):
        return False
    return isinstance(doc, dict) and "tcp" in doc


def _route_yml(key: str, host: str, *backends: str, sticky: bool = True,
               wildcard: str = "", local: bool = False) -> str:
    servers = "\n".join(f'          - url: "{b}"' for b in backends)
    # certResolver rather than a static certificate: the edge requests per
    # name, and Traefik derives WHAT to request from the Host() rule -- which is
    # why the rule must name the host and not be a bare PathPrefix.
    #
    # `domains` overrides that derivation. Naming the wildcard makes every router
    # under it resolve to ONE certificate: Traefik obtains it once and reuses it,
    # which is the difference between 1 and N against the weekly limit (§6).
    # A local certificate is LOADED from disk (issue_local_cert wrote it into the
    # watched directory), so naming a resolver would make Traefik go and request
    # one from Let's Encrypt for a .localhost name that can never be validated.
    tls_block = ("      tls: {}\n" if local
                 else "      tls:\n        certResolver: le\n")
    if wildcard and not local:
        tls_block += ("        domains:\n"
                      f"          - main: \"{wildcard}\"\n")
        if wildcard.removeprefix("*.") == host:
            # The apex is not matched by its own wildcard, so the router that
            # requests it has to ask for both or the GUI's own name is uncovered.
            tls_block = ("      tls:\n        certResolver: le\n"
                         "        domains:\n"
                         f"          - main: \"{host}\"\n"
                         f"            sans: [\"{wildcard}\"]\n")
    body = (
        "# Generated by rc-repro. Do not edit by hand.\n"
        "http:\n"
        "  routers:\n"
        f"    {key}:\n"
        f'      rule: "Host(`{host}`)"\n'
        "      entryPoints: [websecure]\n"
        f"      service: {key}\n"
        + tls_block
        + "  services:\n"
        f"    {key}:\n"
        "      loadBalancer:\n"
        "        servers:\n"
        f"{servers}\n"
    )
    if sticky:
        # DDP websockets must not be bounced between instances mid-session.
        body += ("        sticky:\n"
                 "          cookie:\n"
                 "            name: rc_lb\n"
                 "            secure: true\n")
    return body


# --- disk ---------------------------------------------------------------------

def write(fd: Edge) -> None:
    """Materialise `<home>/edge/` -- compose file and the watched directory."""
    from rc_repro import compose as compose_mod

    dynamic_dir().mkdir(parents=True, exist_ok=True)
    # Before compose mounts it: a bind-mount source that does not exist is created
    # by Docker, owned by root, and then rc-repro cannot write certificates into it.
    certs_dir().mkdir(parents=True, exist_ok=True)
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    runner.atomic_write(compose_path(), compose_mod.to_yaml(compose_doc(fd)))
    runner.atomic_write(edge_dir() / "domain", fd.domain + "\n")
    # THE WHOLE SPEC, because `current()` could only reconstruct the domain and the
    # wildcard flag -- it silently dropped the email, the GUI host and the GUI port, so
    # nothing but `serve --domain` could rebuild this edge faithfully. That is why
    # `rc-repro edge start` could not apply a changed `acme.challenge`: it had no way to
    # regenerate the compose file without losing where the GUI lives.
    runner.atomic_write(edge_dir() / SPEC_FILE, json.dumps(asdict(fd), indent=2))
    # ONLY with a domain. A bare edge (started by `up --https` on a box that has
    # no public name) has nothing to route to the GUI, and writing the route
    # anyway produced `Host(``)` -- which Traefik rejects at load with "empty args
    # for matcher Host", and then names a certResolver that a bare edge does not
    # declare either. Two errors on every start, for a route that cannot work.
    if fd.domain:
        runner.atomic_write(route_path("_gui"), gui_route_yml(fd))
    else:
        route_path("_gui").unlink(missing_ok=True)


def register(name: str, host: str, instances: int = 1, local: bool = False,
             passthrough: str = "") -> bool:
    """Add (or replace) a workspace's route. Picked up without a restart.

    Returns whether `host` needs a certificate OF ITS OWN -- False when the edge's
    wildcard already covers it, which is what the caller counts against the weekly
    limit (§6). Decided here because this is where the edge's own configuration is
    readable.

    Attaching is part of registering, not a separate step a caller can forget: a
    route pointing at a container the edge cannot resolve is a 502 rather than an
    error, which is the hardest kind of failure to diagnose.

    `passthrough` is an `<address>:<port>` the edge forwards raw TCP to instead of
    terminating -- a Kubernetes workspace's ingress. It takes a plain address on
    purpose: the edge has no business knowing what a cluster is, and keeping this
    module runtime-agnostic is what stops "does this workspace terminate TLS" from
    becoming a build-time property again. The caller resolves the address; this
    writes a route to it.

    Two things do NOT happen for a passthrough, and both would be wrong rather than
    merely wasteful. There is no `attach`: that joins a Docker network named after a
    compose project, and a Kubernetes workspace has neither. And the return is always
    False, because no certificate is requested for a name the edge does not present
    one for -- counting it against the weekly limit would spend budget on nothing.
    """
    dynamic_dir().mkdir(parents=True, exist_ok=True)
    if passthrough:
        runner.atomic_write(route_path(name),
                            passthrough_route_yml(name, host, passthrough))
        return False
    door = current()
    covered = bool(door and door.covers(host))
    runner.atomic_write(route_path(name), workspace_route_yml(
        name, host, instances, local=local,
        wildcard_base=door.domain if (covered and door) else ""))
    attach(name)
    return not covered


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
    spec = edge_dir() / SPEC_FILE
    if spec.is_file():
        try:
            data = json.loads(spec.read_text(encoding="utf-8"))
            fields = {f.name for f in dataclasses.fields(Edge)}
            return Edge(**{k: v for k, v in data.items() if k in fields})
        except (OSError, ValueError, TypeError):
            pass                       # fall through rather than fail a start
    domain = served_domain()
    from rc_repro import tls as tlsmod
    return Edge(domain=domain, wildcard=bool(domain and tlsmod.dns_env_vars()))


def deregister(name: str) -> None:
    """Remove a workspace's route. Removing the file 404s that host and leaves
    every other route untouched -- verified."""
    route_path(name).unlink(missing_ok=True)


def holders_of_443() -> list[str]:
    """Workspaces running their OWN Traefik on 443.

    They predate the edge, and they are why it cannot start: a machine has
    one port 443, and theirs already has it. Read from the record rather than from
    docker, so this answers the same whether they are running or merely `down`.
    """
    out = []
    for meta in runner.list_meta():
        extra = meta.extra if isinstance(meta.extra, dict) else {}
        if extra.get("edge"):
            continue
        if 443 in [int(p) for p in (extra.get("tls_ports") or []) if str(p).isdigit()]:
            out.append(meta.name)
    return out


def adopt(name: str) -> dict:
    """Move a workspace that runs its OWN Traefik onto the edge, without
    recreating it.

    Four steps, none of which stops Rocket.Chat or MongoDB:

      1. remove ONLY the workspace's traefik container -- this is what frees 443
      2. attach the edge to the workspace's network, live
      3. write the route
      4. rewrite the compose file so a future `up` matches reality

    Step 4 is a file write and is NOT applied: compose files take effect on the
    next `up`, so nothing restarts now. That is the difference from the first
    version, which called `up` here and therefore recreated every container --
    minutes of downtime per workspace, and a rebuild is where an incompatibility
    or a lost volume would come from. Twenty workspaces is now twenty seconds.
    """
    from rc_repro import compose as compose_mod
    from rc_repro import tls as tlsmod

    meta = runner.read_meta(name)
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    host = (meta.public_url or "").split("://", 1)[-1].split("/", 1)[0]
    if extra.get("tls") != tlsmod.MODE_ACME or not host:
        raise ValidationError(
            f"{name!r} is not a --domain workspace, so there is nothing to move "
            "onto the edge")

    # 1. Its Traefik, and only its Traefik. `docker rm -f` on one container leaves
    #    every other service in the project running.
    _docker("rm", "-f", backend_container(name, tlsmod.SERVICE))

    # 2. Live attach -- no restart of anything. Only if the edge exists yet:
    #    adoption usually runs BEFORE it starts, because freeing 443 is the whole
    #    reason it could not. reattach_all() picks these up after the start.
    if running():
        attach(name)

    # 3 + 4.
    instances = extra.get("instances") if isinstance(extra.get("instances"), int) else 1
    doc = runner.read_compose(name)
    doc.get("services", {}).pop(tlsmod.SERVICE, None)
    extra = dict(extra)
    extra["edge"] = True
    # It no longer publishes 443, and leaving the claim would make every later
    # workspace allocate around a port this one does not hold.
    extra["tls_ports"] = []
    meta.extra = extra
    runner.write(name, compose_mod.to_yaml(doc), meta)
    register(name, host, instances=instances)
    return {"name": name, "host": host}


#: The host a generated route matches, whichever kind it is. `Host()` for an HTTP
#: router, `HostSNI()` for a TCP passthrough.
_RULE_HOST = re.compile(r"Host(?:SNI)?\(`([^`]+)`\)")


def route_host(name: str) -> str:
    """The hostname `name`'s route claims, or "".

    Read from the file rather than from the workspace record, for the same reason
    `is_passthrough` is: a route outlives its workspace, and the caller that needs to
    know about a collision is looking at routes.
    """
    try:
        found = _RULE_HOST.search(route_path(name).read_text(encoding="utf-8"))
    except OSError:
        return ""
    return found.group(1) if found else ""


def host_owner(host: str, *, excluding: str = "") -> str:
    """Which OTHER workspace's route already claims `host`, or "".

    NOTHING CHECKED THIS, and ports have been guarded since long before names were.
    A route file is keyed by WORKSPACE NAME, so two workspaces given the same
    `--domain` each write their own file claiming the same `Host()` -- and Traefik
    picks one. That is the failure this module's own docstring warns about one layer
    down, in the same words: it "looks stable under testing and would silently serve
    the wrong workspace forever".

    Found by running it: three route files on one box all claiming
    `HostSNI(rc-rpro-test.kestron.org)` after a matrix of scenarios, two of them
    pointing at NodePorts that no longer existed. Traefik chose a dead one, so the
    name returned EOF, cert-manager's self check failed, and the certificate never
    issued -- for a chain that was otherwise completely correct.

    `excluding` is the workspace being created or brought back, which is allowed to
    re-claim its own name.
    """
    if not host:
        return ""
    for other in registered():
        if other == excluding:
            continue
        if route_host(other).casefold() == host.casefold():
            return other
    return ""


def routes_for(host: str) -> list[str]:
    """EVERY route file claiming `host`, not just the first.

    `host_owner` answers "is this name taken", which needs one name and stops. This
    answers "what would I have to remove to free it", and the difference is not
    theoretical: the collision that cost an hour of debugging was THREE route files
    on one host, two of them pointing at NodePorts that no longer existed. A cleanup
    that removed one would have left the name still broken and still claimed.
    """
    if not host:
        return []
    return [n for n in registered() if route_host(n).casefold() == host.casefold()]


def registered() -> list[str]:
    """Workspace names with a route right now (the GUI's own route excluded)."""
    if not dynamic_dir().is_dir():
        return []
    return sorted(p.stem for p in dynamic_dir().glob("*.yml")
                  if not p.stem.startswith("_"))


# --- docker -------------------------------------------------------------------

def _docker(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    """Run one docker command. NEVER RAISES; the caller reads returncode.

    Same contract as `k8s.run`, and it did not have it. A missing binary or a timeout
    came out as a raw `FileNotFoundError`/`TimeoutExpired` from a seam every caller
    treats as returning a result -- so on a box with no docker at all, `edge status`,
    `register` and `attach` produced a traceback instead of the handled error the rest
    of the tool gives. 127 is what a shell reports for "command not found", and the
    reason travels in stderr where `_why` already looks for it.
    """
    try:
        return subprocess.run(["docker", *args], text=True, capture_output=True,
                              timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(["docker", *args], returncode=127,
                                           stdout="", stderr=str(exc))


#: Where a unit file goes. Printed, never written -- see systemd_unit().
UNIT_PATH = "/etc/systemd/system/rc-repro.service"


def systemd_unit(exec_start: str, user: str) -> str:
    """The unit that keeps `rc-repro serve` up (design §3.2).

    Printed for the operator to install, never written by rc-repro: writing it
    needs root, and a tool that edits /etc/systemd on your behalf is a bigger
    thing to trust than one that shows you the file. It also keeps this testable
    as a pure string, with no privileged CI.

    `Restart=always` is only safe BECAUSE named accounts exist: with the old
    session token every restart minted a new one and killed every bookmark.
    """
    return (
        "[Unit]\n"
        "Description=rc-repro GUI\n"
        "After=docker.service\n"
        "Requires=docker.service\n"
        "\n"
        "[Service]\n"
        f"User={user}\n"
        f"ExecStart={exec_start}\n"
        "Restart=always\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )


def bridge_address() -> str:
    """The Docker bridge gateway, or "" if it cannot be determined.

    What the GUI binds when a edge is in front of it: the edge reaches
    it here (via host.docker.internal, which resolves to this), and nothing off the
    box can -- verified reachable from a container and refused from 127.0.0.1. That
    is strictly better than 0.0.0.0, which would publish the control plane to the
    whole network just so one container could reach it.

    Read rather than hardcoded to 172.17.0.1: that is only the DEFAULT bridge
    subnet, and a box with a custom `bip` or an occupied 172.17/16 gets a different
    one.
    """
    out = _docker("network", "inspect", "bridge", "--format",
                  "{{(index .IPAM.Config 0).Gateway}}")
    return out.stdout.strip() if out.returncode == 0 else ""


def container_addresses() -> list[str]:
    """Every IP the edge container currently holds, one per network it has joined.

    This is what `serve --domain` trusts for X-Forwarded-*, and it has to be the
    EXACT set rather than a subnet: the edge reaches the host from an address on a
    workspace network, and that /16 also contains the customer-image Rocket.Chat
    containers. A CIDR here would hand X-Forwarded-For to every workspace.

    Re-read rather than cached: the set changes as the edge joins networks.
    """
    out = _docker("inspect", CONTAINER, "--format",
                  "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")
    if out.returncode != 0:
        return []
    return [a for a in out.stdout.split() if a]


def attached_networks() -> set[str]:
    """Workspace networks the edge is currently joined to."""
    out = _docker("inspect", CONTAINER, "--format",
                  "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}")
    if out.returncode != 0:
        return set()
    return {ln.strip() for ln in out.stdout.splitlines() if ln.strip()}


def attach(name: str) -> bool:
    """Join the edge to `name`'s own network, live. Idempotent.

    This is what replaces recreating the workspace. `docker network connect` acts
    on a RUNNING container -- verified: reachable immediately afterwards, with the
    target's StartedAt unchanged. Nothing stops, nothing is rebuilt, no volume is
    touched, so doing this to twenty workspaces costs twenty seconds rather than
    twenty rebuilds.

    Joining the EDGE to the workspace's network (rather than the workspace to a
    shared one) is what preserves isolation: each workspace keeps the private
    network compose already gave it, and verified that w1 could reach w2 neither
    by name nor by IP with the edge attached to both.
    """
    net = workspace_network(name)
    if net in attached_networks():
        return True
    # A workspace that has never been `up`ed has no network yet; not an error, the
    # attach simply happens after it is created.
    return _docker("network", "connect", net, CONTAINER).returncode == 0


def attach_network(net: str) -> bool:
    """Join the edge to a Docker network BY NAME. Idempotent.

    `attach` joins a network derived from a WORKSPACE name, which is every network the
    edge has ever needed -- until a cluster turned out to be one too. A kind cluster's
    node is a container on kind's own Docker network, so its NodePort is reachable from
    the host and NOT from a container on the default bridge, which is where the edge
    lives. Measured exactly that way: `172.18.0.2:30925` answered from the host and
    from a container on the `kind` network, and was unreachable from one on `bridge`.

    Kept separate from `attach` rather than generalising it: that function's whole
    contract is "the network compose made for this workspace", and its name is what
    makes the container-name routing rule readable.
    """
    if not net or net in attached_networks():
        return True
    return _docker("network", "connect", net, CONTAINER).returncode == 0


def container_network(container: str) -> str:
    """The first Docker network `container` is on, or "".

    Used to find out where a cluster's node lives, so the edge can join it. Read
    rather than assumed: kind's default network is called `kind`, but a cluster
    created with a different config need not be on it.
    """
    out = _docker("inspect", container, "--format",
                  "{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}")
    if out.returncode != 0:
        return ""
    names = [n for n in out.stdout.split() if n]
    return names[0] if names else ""


def detach(name: str) -> None:
    """Leave `name`'s network. Best-effort -- the network may already be gone."""
    _docker("network", "disconnect", "-f", workspace_network(name), CONTAINER)


def _compose(*args: str, timeout: float | None = None) -> subprocess.CompletedProcess:
    """`docker compose` in the edge's own project. NEVER RAISES; read the returncode.

    An explicit -p: the project must NOT be derived from the directory name, or it
    would depend on where <home> happens to be.

    THE SAME CONTRACT `_docker` ABOVE ALREADY HAD, and this did not -- one function
    apart, for the same reason, and it was the one that broke. `cwd` is `edge_dir()`,
    and a home that has never had an edge has no such directory, so `subprocess.run`
    raised FileNotFoundError out of a seam every caller treats as returning a result:
    `rc-repro edge stop` on a fresh home answered with a Python traceback naming a
    path under RC_REPRO_HOME. `_compose_capture` had the guard; this did not.

    127 is what a shell reports for "could not run it", and the reason travels in
    stderr where `_why` already looks for it.
    """
    argv = ["docker", "compose", "-p", PROJECT, *args]
    try:
        return subprocess.run(argv, cwd=edge_dir(), text=True,
                              capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(argv, returncode=127, stdout="",
                                           stderr=str(exc))


def port_holder(port: int = 443) -> str:
    """What is holding `port`, named, or "" if nothing is.

    The edge failing to bind is the one startup error that is genuinely somebody
    else's fault, and "the edge did not start" is useless on its own -- hit twice
    while building this, once from a stale front door left by an older rc-repro
    and once from an unrelated Traefik. Docker can name a container; anything else
    is at least identified as not-us.
    """
    out = _docker("ps", "--format", "{{.Names}}\t{{.Ports}}")
    if out.returncode == 0:
        mine = running()
        for line in out.stdout.splitlines():
            name, _, ports = line.partition("\t")
            if f":{port}->" not in ports:
                continue
            # Skipping by NAME alone hid the most confusing case of all: an edge
            # from a different RC_REPRO_HOME has exactly our container name, so it
            # was excluded as "us" and reported as "something outside Docker".
            if name == CONTAINER and mine:
                continue
            if name == CONTAINER:
                return f"an edge from another RC_REPRO_HOME ({name!r})"
            return f"the container {name!r}"
    from rc_repro import runner as runner_mod

    return "" if runner_mod.port_free(port) else "something outside Docker"


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
    if not installed() or not running():
        return [], []
    try:
        import yaml

        doc = yaml.safe_load(compose_path().read_text(encoding="utf-8")) or {}
        svc = next(iter((doc.get("services") or {}).values()), {}) or {}
        want = [str(a) for a in (svc.get("command") or [])]
    except (OSError, ValueError, yaml.YAMLError):
        return [], []
    out = _docker("inspect", CONTAINER, "--format", "{{json .Config.Cmd}}")
    if out.returncode != 0:
        return [], []
    try:
        got = [str(a) for a in (json.loads(out.stdout or "null") or [])]
    except ValueError:
        return [], []
    if not want or not got:
        return [], []
    return ([f for f in want if f not in got], [f for f in got if f not in want])


def has_acme() -> bool:
    """Whether the running configuration declares a certificate resolver."""
    try:
        return "certificatesresolvers" in compose_path().read_text()
    except OSError:
        return False


def _why(res: subprocess.CompletedProcess, limit: int = 500) -> str:
    """The line that explains a docker failure, not the first 500 characters of noise.

    Same rule as `k8s.why`, and for the same reason: compose puts its diagnostics FIRST
    and its error LAST, so taking a prefix reliably shows the least useful part.
    """
    text = "\n".join(t for t in ((res.stderr or ""), (res.stdout or "")) if t)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for ln in reversed(lines):
        low = ln.lower()
        if low.startswith("error") or "error:" in low or "cannot" in low:
            return ln[:limit]
    return (lines[-1][:limit] if lines else "docker said nothing")


@dataclass(frozen=True)
class StartResult:
    """Whether the edge came up, and if not, WHY.

    A bool for two years, and the reason was captured and dropped on the floor:
    `up()` ran `docker compose up` with `capture_output=True` and returned only the
    return code, so both failure sites could do nothing but guess at `port_holder(443)`
    and point at a directory. On a fresh EC2 box that produced "error: the edge did not
    start." with `docker ps -a` empty -- no container, no clue, and the actual compose
    error discarded one frame below.

    `__bool__` is the ok flag so every existing `if not ensure_running(...)` keeps
    meaning what it meant; `.why` is new information rather than a changed contract.
    """
    ok: bool
    why: str = ""

    def __bool__(self) -> bool:
        return self.ok


def ensure_running(acme_email: str = "", acme_staging: bool = False) -> "StartResult":
    """Start the edge if something now needs it, configured for what needs it.

    Lazily, on the first route -- never at install, never on plain `serve`. A
    laptop that never asks for a name never learns this exists, which is the
    thing the previous version got wrong by tying it to `serve --domain`: a
    workspace could not have HTTPS unless the GUI had a public hostname, and
    those are unrelated questions.

    `acme_email` is the workspace's, and it MATTERS. A bare edge declares no
    resolver -- right for `up --https`, which only ever serves local-CA names --
    and a `--domain` workspace registered against it produced routes Traefik
    rejected with "Router uses a nonexistent certificate resolver: le", so the
    name 404'd while looking perfectly configured from the outside. The first
    workspace that needs Let's Encrypt therefore teaches the edge how to ask.
    """
    # Repair a GUI route left by an older rc-repro. That version wrote one even
    # with no domain, producing `Host(``)` -- which Traefik rejects at every
    # reload with "empty args for matcher Host", plus a certResolver a bare edge
    # never declares. Not writing it any more does nothing for the edges that
    # already have it, and nobody would think to look in a generated directory.
    gui = route_path("_gui")
    if not served_domain() and gui.exists():
        gui.unlink(missing_ok=True)

    want_acme = bool(acme_email)
    if not installed():
        write(Edge(acme_email=acme_email, acme_staging=acme_staging)
              if want_acme else Edge())
    elif want_acme and not has_acme():
        # Upgrade in place: keep whatever domain `serve` gave it, add the resolver.
        write(Edge.resolve(served_domain(), acme_email,
                           acme_staging=acme_staging))
        down()                 # so the new flags are actually applied
    if running():
        # RUNNING IS NOT UP TO DATE. This returned True here, and the caller had already
        # rewritten the compose file -- `serve --domain X --email Y` calls `write(door)`
        # first -- so a changed resolver email, a changed domain or any new flag was
        # written to disk and never applied. The container kept the command line it was
        # created with, `serve` reported success, and nothing said the two disagreed.
        # Found on a box whose `acme.json` held an account for a MIStyped address while
        # the corrected one was being passed on every restart.
        #
        # `docker compose up -d` is the right instrument: it is idempotent and recreates
        # the container ONLY if the resolved configuration changed, so this costs one
        # compose call when nothing has and does the necessary thing when something has.
        # The adoption loop below is skipped -- nothing else can be holding :443 while
        # this edge has it.
        res = up(pull=False)
        return (StartResult(True) if res.returncode == 0
                else StartResult(False, _why(res)))
    # Workspaces from before the edge run their own Traefik on 443, which is
    # exactly why the edge cannot start. Moving them across is now instant and
    # touches no data, so it happens automatically rather than behind a flag --
    # the flag existed when doing this meant recreating every container, and
    # asking permission for something expensive is very different from asking
    # permission for removing one proxy container.
    for held in holders_of_443():
        try:
            adopt(held)
        except (ReproError, OSError):
            # One workspace that will not move must not stop the others, or the
            # edge. Whatever still holds the port is named by port_holder().
            continue
    res = up(pull=False)
    if res.returncode == 0:
        return StartResult(True)
    return StartResult(False, _why(res))


def reattach_all() -> list[str]:
    """Join every routed workspace's network. Returns the ones that failed.

    Attachments are RUNTIME state on the container, so recreating the edge --
    an upgrade, a `restart`, a reboot that pulls a new image -- loses every one
    of them while the route files survive untouched. The result is a set of names
    that answer 502 rather than erroring, so this runs after every start rather
    than waiting for someone to notice.
    """
    failed = []
    for name in registered():
        # A passthrough route has no network to join -- it names an address, not a
        # container. Attaching would run `docker network connect` for a compose
        # project that does not exist, fail, and report a perfectly healthy
        # Kubernetes workspace as one the edge could not reach, on every restart.
        if is_passthrough(name):
            continue
        if not attach(name):
            failed.append(name)
    return failed


def foreign_edge() -> str:
    """The working directory of an edge belonging to a DIFFERENT RC_REPRO_HOME.

    Compose keys a project by NAME, and every home uses the same one, so
    `docker compose -p rcrepro_edge up -d` REPLACES another home's container
    rather than failing -- silently taking down every https name that edge was
    serving. Observed doing exactly that while testing.

    It matters more than the "one shared home" assumption in §3.2 suggests,
    because the default home is `~/.rc-repro`: on a box where two people each run
    rc-repro as themselves, the second `up --https` quietly steals the first
    one's ingress.
    """
    out = _docker("ps", "--filter", f"label=com.docker.compose.project={PROJECT}",
                  "--filter", "status=running", "--format", "{{.ID}}")
    for cid in out.stdout.split():
        where = _docker("inspect", cid, "--format",
                        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
        found = where.stdout.strip()
        if found and found != str(edge_dir()):
            return found
    return ""


def up(*, pull: bool = True) -> subprocess.CompletedProcess:
    """Start the edge, and return what docker said. No network to create: it joins
    each workspace's own.

    Returns the CompletedProcess rather than its return code, because the return code
    was all the callers ever got and a failed start is precisely the moment the output
    matters -- see `StartResult`.
    """
    other = foreign_edge()
    if other:
        # Refuse rather than replace. `compose up` would happily take the other
        # home's container, and the first anyone would know is every one of its
        # names going dark.
        raise ConflictError(
            "another rc-repro edge is already running on this machine, from a "
            f"different home:\n    {other}\n"
            "  Starting this one would REPLACE it and take down every https name "
            "it serves.\n"
            "  rc-repro is designed around one shared home per box — set "
            "RC_REPRO_HOME to the same\n"
            "  directory as the other user, or stop that edge first:\n"
            f"    RC_REPRO_HOME={Path(other).parent} rc-repro edge stop")
    if pull:
        _compose("pull")            # non-fatal, exactly as runner.up does it
    res = _compose("up", "-d", "--remove-orphans")
    if res.returncode == 0:
        # Every start, not just the first: a recreated container has none of its
        # previous attachments, and the route files that outlived it would then
        # all answer 502.
        reattach_all()
    return res


def acme_failure(domain: str = "", tail: int = 400) -> str:
    """The last ACME failure the edge logged, for `domain` or for anything, or "".

    Traefik requests certificates in the BACKGROUND after it starts, so the edge comes
    up healthy, the route loads, `serve` prints an https URL -- and issuance can be
    failing with nobody told. Reported exactly that way: a GUI whose name served
    nothing, while the reason sat in a container log there was no command to read.

    The reason is worth extracting rather than pointing at, because it is usually
    conclusive and short:

        DNS problem: NXDOMAIN looking up A for <name> - check that a DNS record exists
    """
    out = _compose_capture("logs", f"--tail={tail}")
    if not out:
        return ""
    # ANSI FIRST. Traefik colours its own output, so the marker below is really
    # `\x1b[36merror=\x1b[0m\x1b[31m\x1b[1m"` and a literal match finds nothing --
    # which is how the first version of this returned the whole unreadable line.
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    hit = ""
    for line in out.splitlines():
        if "acme" not in line.lower():
            continue
        if "unable to obtain" not in line.lower() and "error" not in line.lower():
            continue
        if domain and domain not in line:
            continue
        hit = line
    if not hit:
        return ""
    # Traefik logs one long structured line; the useful part is the quoted error.
    marker = 'error="'
    if marker in hit:
        hit = hit.split(marker, 1)[1].split('"', 1)[0]
    return " ".join(hit.replace("\\n", " ").split())[:400]


def _compose_capture(*args: str) -> str:
    """`docker compose` in the edge project, captured. "" if it could not run."""
    try:
        res = subprocess.run(["docker", "compose", "-p", PROJECT, *args],
                             cwd=edge_dir(), text=True, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return (res.stdout or "") + (res.stderr or "")


def orphan_certs() -> list[str]:
    """Hostnames declared to the edge whose certificate file is missing or empty.

    Each one is a name that will never serve and an error Traefik repeats for ever, so
    it belongs in `status` rather than only in a log nobody was told about.
    """
    out = []
    for decl in sorted(dynamic_dir().glob("_cert-*.yml")):
        host = decl.name.removeprefix("_cert-").removesuffix(".yml")
        crt = certs_dir() / f"{host}.crt"
        try:
            if not crt.is_file() or not crt.stat().st_size:
                out.append(host)
        except OSError:
            out.append(host)
    return out


# --- forgetting a name --------------------------------------------------------
# `deregister` removes a ROUTE, which is all a teardown needs: the name stops
# answering. It is not all a teardown LEAVES. Route files are keyed by workspace
# name and certificate material by HOSTNAME, so `down --volumes` unlinked
# `dynamic/<name>.yml` and walked past `certs/<host>.crt`, its private key, the
# `_cert-<host>.yml` that loads them, and -- for a real `--domain` -- a Let's
# Encrypt certificate and key sitting in Traefik's ACME store for ever.
#
# Proved by calling exactly what teardown calls, in an isolated home:
#
#     survives a `down --volumes`:
#       edge/certs/T-1234.rcrepro.localhost.crt   (1643B)
#       edge/certs/T-1234.rcrepro.localhost.key   (1704B)   <- private key
#       edge/dynamic/_cert-T-1234.rcrepro.localhost.yml
#     orphan_certs() says: []
#
# `orphan_certs` reported nothing because it flags a declaration whose certificate
# is MISSING, which is the opposite failure -- here everything was present and
# valid, just unreachable. The visible symptom is a TLS handshake that succeeds,
# with a genuine certificate for the name, into a 404.

def acme_stores() -> list[Path]:
    """Both ACME stores, whichever exist.

    Staging and production are SEPARATE files (`tls.acme_storage_name`) and a host
    can be in either -- `config set acme.staging false` after a staging issuance
    leaves the staging entry behind. A delete that looked only at the live one would
    report success and leave a key on disk.
    """
    d = tls.acme_dir()
    return [pth for pth in (d / tls.ACME_FILE, d / tls.ACME_FILE_STAGING) if pth.is_file()]


def _acme_read(path: Path) -> dict:
    """Traefik's store as a dict, or {} -- never an exception.

    A store Traefik has not written yet is empty, and a half-written or hand-edited
    one is not this function's problem to diagnose: both mean "no certificate for
    that host in here", which is the only question being asked.
    """
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _acme_names(cert: dict) -> list[str]:
    dom = cert.get("domain") if isinstance(cert.get("domain"), dict) else {}
    names = [dom.get("main") or ""]
    names += [str(s) for s in (dom.get("sans") or [])]
    return [n.casefold() for n in names if n]


def acme_hosts() -> list[str]:
    """Every hostname the ACME stores hold a certificate for.

    Read from the store rather than from the routes, deliberately: a certificate
    OUTLIVES the route that asked for it, and this exists to find the ones nothing
    points at any more.
    """
    out: set[str] = set()
    for path in acme_stores():
        for resolver in _acme_read(path).values():
            if not isinstance(resolver, dict):
                continue
            for cert in resolver.get("Certificates") or []:
                if isinstance(cert, dict):
                    out.update(_acme_names(cert))
    return sorted(out)


def forget_acme(host: str) -> list[str]:
    """Drop `host`'s certificate AND private key from Traefik's ACME stores.

    Returns the store filenames it came out of, so a caller can say what happened
    rather than claiming a deletion it did not make.

    The ACME **Account** is kept. It is a registration with Let's Encrypt, not a
    certificate -- dropping it makes the next issuance register a new key pair for
    no benefit, and account registrations have their own rate limit.

    Written 0600 because what is being rewritten is a file full of private keys, and
    `atomic_write` would otherwise create it 0644 from the umask.
    """
    if not host:
        return []
    want = host.casefold()
    gone: list[str] = []
    for path in acme_stores():
        doc = _acme_read(path)
        touched = False
        for resolver in doc.values():
            if not isinstance(resolver, dict):
                continue
            certs = resolver.get("Certificates")
            if not isinstance(certs, list):
                continue
            keep = [c for c in certs
                    if not (isinstance(c, dict) and want in _acme_names(c))]
            if len(keep) != len(certs):
                resolver["Certificates"] = keep
                touched = True
        if touched:
            runner.atomic_write(path, json.dumps(doc, indent=2), mode=0o600)
            gone.append(path.name)
    return gone


def delete_host(host: str, *, confirm: bool = False, restart: bool = True) -> dict:
    """Forget `host` entirely: its routes, its certificate, its key, its ACME entry.

    Returns what actually went, per kind, so the caller reports the deletion it made
    instead of the one it attempted.

    Three refusals, and each one is a case where deleting would break something the
    caller can still see:

    * a LIVE workspace still claims the name -- `down` it first, named in the error.
      A route whose workspace record is gone is the orphan this command exists for,
      so that one proceeds.
    * the name is the GUI's own -- deleting it takes `serve` off the network the
      operator is most likely using to run this.
    * `confirm` is not set. A private key is not recoverable and this is the only
      gate; `--yes` on the CLI, an explicit body field in the GUI.

    `restart` is the part that is easy to get wrong. Traefik holds its ACME store in
    memory and persists the whole file when a certificate changes, so an edit made
    underneath a running Traefik can be written back from memory later -- the entry
    reappears, hours after a command said it was deleted. Restarting rebuilds that
    memory from the edited file. Routes are files, so every other name comes back
    with no re-registration; that property is why a restart is affordable here.
    """
    host = (host or "").strip().rstrip(".")
    if not host:
        raise ValidationError("name a hostname to delete: `rc-repro edge delete "
                              "<host>`. `rc-repro edge status` lists them.")
    gui = served_domain()
    if gui and gui.casefold() == host.casefold():
        raise ConflictError(
            f"{host} is the GUI's own name, so deleting it would take `rc-repro "
            f"serve` off HTTPS while you are probably using it. Stop the edge "
            f"(`rc-repro edge stop`) if that is really what you want.")
    routes = routes_for(host)
    live = [n for n in routes if runner.exists(n)]
    if live:
        raise ConflictError(
            f"{host} still belongs to workspace {', '.join(live)!r} — deleting its "
            f"certificate would leave a workspace that cannot serve its own name. "
            f"`rc-repro down --name {live[0]} --volumes` first, then delete the "
            f"name.")
    if not confirm:
        raise ValidationError(
            f"deleting {host} removes its certificate and PRIVATE KEY and cannot be "
            f"undone - pass confirm=true")

    # Passthrough first: the answer for a Kubernetes name is genuinely different, and
    # saying "certificate removed" about one that was never here would be a lie in
    # the shape this codebase keeps finding -- reporting the attempt as the outcome.
    through = [n for n in routes if is_passthrough(n)]
    for name in routes:
        deregister(name)
    crt, key = certs_dir() / f"{host}.crt", certs_dir() / f"{host}.key"
    had_cert = crt.is_file() or key.is_file()
    crt.unlink(missing_ok=True)
    key.unlink(missing_ok=True)
    decl = dynamic_dir() / f"_cert-{host}.yml"
    had_decl = decl.is_file()
    decl.unlink(missing_ok=True)
    stores = forget_acme(host)

    # Docker is asked ONLY for an ACME deletion. A route or a local certificate is
    # read from disk every time, so removing the file is already in effect; making a
    # file deletion depend on a daemon to decide it need not restart would be a cost
    # with nothing bought.
    #
    # `running()` is HOME-AWARE -- it matches the compose project label AND the
    # working directory -- so `down()` here cannot reach an edge belonging to a
    # different RC_REPRO_HOME, which every home naming its project `rcrepro_edge`
    # would otherwise make trivially possible. That is not a hypothetical: doing it
    # by hand cost this box's owner their edge once, following an error message that
    # did not know about it either.
    #
    # Which leaves the case worth REPORTING rather than guarding: ours is not
    # running and somebody else's is. A foreign edge mounts its own home's ACME
    # store, so the certificate just deleted was this home's copy and NOT the one
    # being served -- and a plain "removed" would read as a name that stopped
    # resolving.
    foreign, restarted = "", None
    if stores and restart:
        if running():
            restarted = down() == 0 and up(pull=False).returncode == 0
        else:
            foreign = foreign_edge()
    return {
        "host": host,
        "routes": routes,
        "passthrough": through,
        "certificate": had_cert,
        "declaration": had_decl,
        "acme": stores,
        "restarted": restarted,
        "foreign": foreign,
        "kept": ["acme/" + tls.ISSUED_FILE] if tls.issued_path().is_file() else [],
    }


def logs(*, tail: int = 200, follow: bool = False) -> int:
    """Stream or dump the edge's own log, and return the exit code.

    The edge is where HTTPS actually succeeds or fails, and until now there was no way
    to read it from rc-repro: `edge` offered status/start/stop/restart, so the answer to
    "my name serves nothing" lived in a container whose name you had to know. Asked
    verbatim by someone whose https name would not come up -- "where are the default
    logs for it?".

    It matters most for ACME. Traefik requests certificates in the BACKGROUND after it
    starts, so a name can be routed, the edge can be healthy, and issuance can still be
    failing -- and the only record of why is here:

        "unable to obtain ACME certificate for domains ... error presenting token"

    Not captured: this inherits stdout so `-f` behaves like `docker compose logs -f`,
    which is the point of it.
    """
    argv = ["logs", f"--tail={tail}"]
    if follow:
        argv.append("-f")
    # Same seam, same contract: an absent `edge/` must not be a traceback. Not
    # reachable from the CLI, which guards on `installed()` first, and hardened anyway
    # -- a seam that raises for one caller raises for the next one.
    try:
        return subprocess.run(["docker", "compose", "-p", PROJECT, *argv],
                              cwd=edge_dir(), text=True).returncode
    except (OSError, subprocess.SubprocessError):
        return 127


def down() -> int:
    """Stop the edge. Routes are files and survive this, so starting it again
    restores every name with no re-registration."""
    return _compose("down", "--remove-orphans").returncode


def running() -> bool:
    """Whether THIS home's edge is running.

    The project label alone is not enough. Every RC_REPRO_HOME uses the same
    compose project name, so a container started from a different home matched
    and this returned True -- while `installed()`, which reads the current home,
    returned False. `ensure_running()` then skipped writing any configuration,
    the routes went into a directory nothing was watching, and every name 404'd
    with `edge status` reporting "no edge yet" beside a running edge.

    The design assumes ONE shared home per box (§3.2), and this does not change
    that: it makes the unsupported case fail loudly -- the start is attempted and
    refused by whoever holds :443, which port_holder() names -- rather than
    silently doing nothing.
    """
    out = _docker("ps", "--filter", f"label=com.docker.compose.project={PROJECT}",
                  "--filter", "status=running", "--format", "{{.ID}}")
    for cid in out.stdout.split():
        where = _docker("inspect", cid, "--format",
                        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
        if where.stdout.strip() == str(edge_dir()):
            return True
    return False


def status() -> dict:
    """What `doctor` and the GUI report."""
    return {
        "installed": installed(),
        "running": running(),
        "routes": registered(),
        # Which workspace networks it is currently joined to. A route with no
        # attachment is a 502 rather than an error, so the two belong side by side.
        "attached": sorted(attached_networks()),
    }
