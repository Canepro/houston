"""types -- see the package docstring."""
from __future__ import annotations

from dataclasses import dataclass
from houston import tls


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
        from houston import config as cfgmod
        from houston import tls as tlsmod

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
