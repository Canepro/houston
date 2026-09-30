"""The nine values `create_app()` used to hand out by closure, as one named object.

Every one of the ~80 route handlers in `web/app.py` is a nested function inside a
single `create_app()`, and each reaches its configuration by closing over a factory
local. That works exactly as long as the handlers stay inside the factory. The moment
one moves into `web/routes/`, the closure is gone and the value has to arrive some
other way -- so it has to have a name, a type and one construction site first. This
module is that step, and nothing else: introducing the object moves no handler.

**Frozen, and that is the point.** The nine values are decided once, at
`create_app()` time, from its arguments. A handler that could reassign one would be
changing a security attribute -- the host allow-list, the CSP, which cookie name is
live -- for every later request in the process, from inside a request. `frozen=True`
makes that an error at the assignment rather than a puzzle three requests later.

**What is deliberately NOT frozen: `public_https`.** `app.state.public_https` stays the
live source of truth for the cookie's `Secure` flag and `__Host-` prefix, because a
test flips it after the app is built (`tests/test_web.py` pins that a plain-named
cookie is refused once the hop resolves https). `AppContext.public_https` records the
value `create_app()` was CALLED with; `live_public_https()` is the honest way to read
the current one. A handler that snapshots it instead is the stale-copy bug this object
exists to make visible.

**Why the `--trust-proxy` parsing lives here too.** `trust_proxy` is one of the nine
fields, and `parse_trusted`/`trusted_problems` are two readings of the same input -- the
comment on `trusted_problems` has always said they must not be separated. They were
module-level functions in `web/app.py`; `web/app.py` re-exports them so `serve` and the
suite keep importing them from where they always have.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from houston import config

if TYPE_CHECKING:  # pragma: no cover - typing only, and web/ must stay import-light
    from houston.web.jobs import JobManager


#: The field names, in order, as one tuple so a test can assert the shape rather
#: than re-listing it. The shape is a contract: `web/security.py` and the twelve
#: `web/routes/` modules all take this object and nothing else.
FIELDS = ("allowed", "any_host", "csp", "cookie_secure", "cookie_name", "jobs",
          "accounts", "public_https", "trust_proxy")

# `__Host-` is not decoration. team-server.md §3.6 puts workspaces on sibling
# names (t1234.support.example.com) beside the GUI (support.example.com), and
# §8 says every workspace runs admin/admin123 -- so without the prefix a
# workspace can set a Domain-scoped cookie of the same name that the GUI cannot
# tell from its own. The prefix requires Secure, which http://localhost cannot
# have, so there are two names and exactly ONE is live per scheme: honouring
# the plain name over https would hand back everything the prefix bought.
COOKIE_SECURE = "__Host-houston_session"
COOKIE_PLAIN = "houston_session"


@dataclass(frozen=True)
class AppContext:
    """Everything a route module needs from the application factory.

    `cookie_secure` and `cookie_name` are the two cookie NAMES, not a flag and a
    resolver: exactly one of them is live per scheme, and which one is decided per
    request from the resolved hop (see `web/app.py`'s `cookie_name()`). Holding both
    here is what lets that decision move out of the factory.
    """

    #: Host header values the DNS-rebind/CSRF guard accepts, case-folded.
    allowed: frozenset[str]
    #: `--allow-host '*'`: accept any Host at all.
    any_host: bool
    #: The Content-Security-Policy header every response carries.
    csp: str
    #: The `__Host-` prefixed session cookie name, live only over https.
    cookie_secure: str
    #: The plain session cookie name, live only over http.
    cookie_name: str
    #: The per-application background job registry.
    jobs: JobManager
    #: Whether the login is enforced at all.
    accounts: bool
    #: Whether the BROWSER's hop is https, as `create_app()` was told at build time.
    #: Read `live_public_https(app)` for the value a request must act on.
    public_https: bool
    #: Peers whose `X-Forwarded-*` headers are believed. Empty by default.
    trust_proxy: list[Any]


def content_security_policy() -> str:
    """Defence in depth for the SPA.

    script-src 'self' blocks inline handlers, so an injected `<img onerror=...>`
    cannot run even if a renderer forgets to escape. Styles need 'unsafe-inline'
    because the UI sets style ATTRIBUTES; frame-src allows the monitoring stack's
    Grafana, which the k6 result embeds.
    """
    return ("default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self' ws: wss:; "
            f"frame-src 'self' http://localhost:{config.MONITOR_PORTS[1]}; "
            # 'self', not 'none': /signin is a real <form method="post">, and the
            # whole point of it is being a page rather than the browser's own
            # credential dialog. 'self' still blocks posting this page's fields
            # anywhere off-origin.
            "base-uri 'none'; form-action 'self'; object-src 'none'")


def build(*, allow_hosts, jobs, accounts: bool, public_https: bool,
          trust_proxy) -> AppContext:
    """The one construction site, called once from `create_app()`.

    A function rather than nine lines inside the factory so that the values and the
    reasoning for them sit beside the fields they fill, and so a test can build a
    context without building an application.

    `trust_proxy` arrives ALREADY parsed: `create_app()` parses it once and puts the
    same list on `app.state.trusted_proxies`, so the context and the application state
    cannot hold two different answers to one question.
    """
    return AppContext(
        # Host allow-list (DNS-rebind/CSRF guard). Loopback always allowed; extra
        # hosts (e.g. a reverse-proxy domain like *.iximiuz.com) opt in via
        # --allow-host, and "*" trusts any Host. Case-folded on both sides:
        # hostnames are case-insensitive, and comparing raw meant
        # `curl http://LOCALHOST:7070/` and a proxy that forwards
        # `Host: Lab.Example.Com` were both rejected as "host not allowed".
        allowed=frozenset(h.lower() for h in
                          ({"localhost", "127.0.0.1", "::1"} | set(allow_hosts or []))),
        any_host="*" in (allow_hosts or []),
        csp=content_security_policy(),
        cookie_secure=COOKIE_SECURE, cookie_name=COOKIE_PLAIN,
        jobs=jobs, accounts=accounts, public_https=public_https,
        trust_proxy=trust_proxy,
    )


def live_public_https(app) -> bool:
    """The CURRENT https answer, from `app.state`, not the frozen build-time one.

    One function rather than an `app.state.public_https` spelled out at each call
    site, so the places that must not use the frozen copy are greppable.
    """
    return bool(app.state.public_https)


def _rightmost_untrusted(forwarded: str, trusted: list) -> str:
    """The first address from the RIGHT of an X-Forwarded-For that we do not trust.

    An appending proxy writes the peer it saw onto the end of the header, so the
    rightmost entries are the ones our own infrastructure vouched for and everything
    to the left of them is whatever the client chose to send. Taking `[0]` therefore
    took an attacker-supplied value: rotating it gave every request a fresh
    rate-limit key, and the sign-in throttle -- which is the only thing bounding
    password guessing, because scrypt is spent at the endpoint -- never tripped.

    Returns "" when every hop is trusted or the header is empty, and the caller
    keeps the socket peer, which is the only address it can actually verify.
    """
    hops = [h.strip() for h in forwarded.split(",") if h.strip()]
    for hop in reversed(hops):
        try:
            addr = ipaddress.ip_address(hop)
        except ValueError:
            # Unparseable: not something we can vouch for, so it is the answer.
            return hop
        if not any(addr in net for net in trusted):
            return hop
    return ""


def parse_trusted(entries) -> list:
    """`--trust-proxy` values -> networks. A bare address becomes a /32 or /128.

    Refuses nothing loudly: an unparseable entry is dropped rather than crashing
    `serve`, because the failure mode of a typo here should be "the proxy is not
    trusted" (which is safe and visible) rather than a server that will not start.
    """
    out = []
    for raw in entries or []:
        for part in str(raw).split(","):
            part = part.strip()
            if not part:
                continue
            try:
                out.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                continue
    return out


def _matches_nothing(net) -> bool:
    """The wildcard address pinned to a single host: 0.0.0.0/32, ::/128.

    Syntactically valid, matches no peer that ever connects, and the only reason
    anyone types it is meaning "anywhere". One predicate because three callers ask
    the same question -- the diagnosis, the effective set, and the posture line --
    and answering it three ways is how two of them end up disagreeing.
    """
    return int(net.network_address) == 0 and net.prefixlen == net.max_prefixlen


def _matches_everything(net) -> bool:
    """0.0.0.0/0 or ::/0 — every address there is.

    Usable, unlike `_matches_nothing`, so nothing refuses it; but it says "believe
    X-Forwarded-* from anyone", which is a different statement from "believe my
    proxy" and worth hearing out loud. resolve_peer()'s docstring spells out both
    consequences: a chosen scheme turns Secure on, and a chosen address dodges the
    sign-in throttle.
    """
    return int(net.network_address) == 0 and net.prefixlen == 0


def usable_trusted(entries) -> list[str]:
    """The given entries that can actually match a peer, as written.

    What the posture line and the app should both go by. `--trust-proxy 0.0.0.0`
    made `serve` announce "https, trusted from 0.0.0.0" while trusting nothing,
    because the line tested whether the LIST was non-empty rather than whether
    anything in it could match.
    """
    out = []
    for raw in entries or []:
        for part in str(raw).split(","):
            part = part.strip()
            if not part:
                continue
            try:
                net = ipaddress.ip_network(part, strict=False)
            except ValueError:
                continue
            if not _matches_nothing(net):
                out.append(part)
    return out


def trusted_problems(entries) -> list[str]:
    """What is wrong with these `--trust-proxy` values, in the order given.

    Kept beside parse_trusted() because it is a second reading of the same input:
    apart, one of them drifts and the diagnosis stops matching the behaviour.

    Dropping a bad entry silently is right for the PARSER -- a typo should mean
    "that proxy is not trusted", never a server that will not start. Saying
    nothing about it is what made `--trust-proxy 0.0.0.0` survive: it parses, it
    is not dropped, and it becomes 0.0.0.0/32 -- an address no peer ever has. The
    flag is then indistinguishable from --insecure, the cookie it was passed to
    mark Secure is not Secure, and nothing anywhere says so.
    """
    out = []
    for raw in entries or []:
        for part in str(raw).split(","):
            part = part.strip()
            if not part:
                continue
            try:
                net = ipaddress.ip_network(part, strict=False)
            except ValueError:
                out.append(f"--trust-proxy {part!r} is not an address or CIDR, "
                           "so it was ignored — no proxy is trusted by it.")
                continue
            if _matches_everything(net):
                out.append(
                    f"--trust-proxy {part} trusts X-Forwarded-* from ANY client, "
                    "not just a proxy: anyone can then claim X-Forwarded-Proto: "
                    "https to get a Secure cookie and silence the unencrypted "
                    "warning, and set X-Forwarded-For to dodge the sign-in "
                    "throttle. Name the proxy's own address instead.")
                continue
            if _matches_nothing(net):
                every = "0.0.0.0/0" if net.version == 4 else "::/0"
                out.append(f"--trust-proxy {part} means the single address {net}, "
                           f"which no proxy has — did you mean {every}? As it "
                           "stands nothing is trusted and the session cookie will "
                           "not be marked Secure.")
    return out
