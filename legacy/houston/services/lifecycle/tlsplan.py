"""Everything HTTPS a workspace can be given, decided before anything is built.

Tier 3. A workspace never terminates TLS -- one Traefik edge holds :80/:443 for the box
and a workspace gains or loses HTTPS by a route file appearing or disappearing. So this
module produces a PLAN and a name, and the create path acts on it; nothing here starts a
container.
"""
from __future__ import annotations

import time

from houston import config, runner
from houston.errors import (AuthorityGateError, ConflictError, PreflightError,
                            ValidationError)
from houston.services import edge as edgesvc
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle.types import (PUBLISH_PROOF_PAUSE, PUBLISH_PROOF_TRIES,
                                              CreateReq, _KubeTls)

def _tls_from_record(name: str) -> "tuple[bool, str] | None":
    """(https, domain) an EXISTING workspace was created with, or None.

    Read from repro.json rather than remembered in the request, because the `up`
    that brings a workspace back is a different invocation -- usually a different
    day -- from the one that gave it a name.
    """
    if not name or not runner.exists(name):
        return None
    try:
        meta = runner.read_meta(name)
    except Exception:  # noqa: BLE001 - half-written record
        return None
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    mode = extra.get("tls")
    if not mode or not meta.public_url:
        return None
    from houston import tls as tlsmod

    if mode == tlsmod.MODE_LOCAL:
        return (True, "")
    host = meta.public_url.split("://", 1)[-1].split("/", 1)[0]
    return (False, host) if host else None


def _recorded_local_host(name: str) -> str:
    """The `.localhost` name this workspace already holds a certificate for, or "".

    A local-CA hostname used to be re-derivable from the workspace name plus the
    suffix, so nothing had to remember it -- which is why `_tls_from_record` above
    returns an empty domain for MODE_LOCAL. Renaming the tool changed the suffix,
    and a later `up` would then mint a SECOND hostname for a workspace whose issued
    leaf, whose Traefik route and whose Rocket.Chat ROOT_URL all still say the first
    one, leaving the bookmark the user actually has pointing at a name the edge no
    longer answers for. So it is read back rather than recomputed.
    """
    from urllib.parse import urlsplit

    url = runner.recorded(name, "public_url")
    host = urlsplit(url).hostname if url else ""
    return host if host and host.endswith(".localhost") else ""


def _name_reaches(host: str, claim) -> bool:
    """Whether `host` resolves to the address the cluster's ingress answers on.

    Unresolvable is True, deliberately: a `--domain` whose DNS has not propagated yet
    is the normal case for a name being set up, and answering False there would move
    a public name onto the edge for a reason that stops being true minutes later.
    The case this exists to catch is a name that resolves SOMEWHERE ELSE, which is
    a fact rather than a not-yet.
    """
    import socket
    address = str(getattr(claim, "address", "") or "")
    if not address:
        return False
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(host, 443)}
    except OSError:
        return True
    return address in addrs


def _pick_challenge(req: CreateReq, cfg: dict, emit: Emit = null_emit) -> None:
    """Choose the ACME challenge. Not a flag -- there is a right answer.

    TLS-ALPN-01 is the default and what the official compose uses. It needs Let's
    Encrypt to reach this host on 443, which is impossible behind NAT, behind a
    tunnel, or behind a proxy that terminates TLS in front of the origin.

    dns-01 needs none of that: the provider's API writes a TXT record and Let's
    Encrypt never connects here. So it is selected exactly when credentials for it
    exist, which is the only signal that says "the operator set this up on purpose".
    """
    from houston import tls as tlsmod

    if not tlsmod.dns_env_vars():
        req.acme_challenge = "tlsalpn"
        return
    provider = str(cfg.get("acme_dns_provider") or "")
    if not provider:
        provider, why = tlsmod.infer_dns_provider()
        if not provider:
            # Credentials are present but unreadable as a provider. Falling back to
            # tlsalpn silently would ignore a file the user deliberately created.
            raise ValidationError(
                f"{tlsmod.dns_env_path()} exists, so dns-01 was assumed, but the "
                f"provider could not be worked out: {why}.\n"
                f"  Name it with `houston config set acme.dns_provider <name>` — "
                f"providers and their variables: {tlsmod.LEGO_PROVIDER_DOCS}\n"
                f"  Or delete the file to use the inbound challenge instead.")
    ok, detail = tlsmod.dns_credentials(provider)
    if not ok:
        raise ValidationError(detail)
    req.acme_challenge = "dns"
    req.acme_dns_provider = provider
    info(emit, f"using the dns-01 challenge via {provider} ({detail}) — no inbound "
               "connection needed, so the workspace stays on loopback", phase="tls")


def _challenge_mode(domain, emit, req, tlsmod):
    """Which ACME challenge this request means, and what each one implies about the bind."""
    cfg = config.load_config()
    if domain:
        mode = tlsmod.MODE_ACME
        # DOMAIN + LETSENCRYPT_EMAIL, the two the official compose asks for. The
        # email is remembered so only the first run needs it.
        req.acme_email = req.acme_email or str(cfg.get("acme_email") or "")
        if not req.acme_email:
            raise ValidationError(
                "a Let's Encrypt certificate needs a contact email:\n"
                "  houston up ... --domain " + domain + " --email you@example.com\n"
                "It is remembered after the first use, or set it once with:\n"
                "  houston config set acme.email you@example.com")
        # `config.truthy`, not `bool`: a config written by an older houston holds the
        # STRING "false", which bool() reads as True -- so staging could never be
        # turned back off. See config.truthy for the measurement.
        req.acme_staging = req.acme_staging or config.truthy(cfg.get("acme_staging"))
        _pick_challenge(req, cfg, emit)
    else:
        mode = tlsmod.MODE_LOCAL

    # The workspace stays on loopback whatever the challenge. It publishes no TLS
    # port at all now, so there is nothing for Let's Encrypt to connect TO here --
    # the EDGE answers the TLS-ALPN challenge on 443, for every name it serves.
    # Widening a workspace's bind (these run fixed weak credentials) for a
    # challenge that no longer reaches it would expose them for nothing.
    req.bind_public = False

    return mode


def _resolve_tls(req: CreateReq, repro_name: str, bind_host: str, exclude: str = "",
                 emit: Emit = null_emit):
    """Turn the --https flags into a tls.TlsSpec, or None when --https is absent.

    Validates here rather than letting Traefik fail at boot: a bad combination
    otherwise produces a repro that comes up and serves nothing, with the reason
    only in `docker compose logs traefik`.
    """
    # A domain means HTTPS; requiring --https alongside it was ceremony. --https on
    # its own selects the local-CA mode, which needs nothing else.
    if not (req.https or req.domain or req.acme_email):
        # ...unless this workspace ALREADY has an https name. `down` then `up` is
        # the documented way to bring a workspace back ("data intact"), and it
        # silently dropped TLS: the record went on claiming public_url while
        # nothing served it. Harmless to re-derive, because the name and the
        # certificate both live outside the workspace -- restoring it is writing a
        # route file, where before it would have meant rebuilding a Traefik.
        restored = _tls_from_record(exclude or repro_name)
        if restored is None:
            return None
        req.https, req.domain = restored
        if not (req.https or req.domain):
            return None
        info(emit, f"restoring the https name this workspace already had"
                   f"{' (' + req.domain + ')' if req.domain else ''}", phase="tls")

    from houston import tls as tlsmod

    # Normalized before anything else reads it: it becomes ROOT_URL, the Host()
    # router rule and a TLS SNI name, so a scheme or trailing slash surviving this
    # far corrupts all three at once.
    domain, fixed = (tlsmod.normalize_domain(req.domain) if req.domain else ("", ""))
    if fixed:
        req.domain = domain          # so downstream and repro.json agree with reality

    mode = _challenge_mode(domain, emit, req, tlsmod)
    host = domain or _recorded_local_host(repro_name) or tlsmod.local_host_for(repro_name)
    # Every name answers on the edge's 443. No port is allocated per workspace and
    # no port is probed: this workspace terminates no TLS, so there is nothing to
    # conflict with. That deletes the whole port-443 arbitration -- the conflict
    # error, the `own_ports` exemption, `_pick_tls_port`, and the http-redirect
    # probe, which the edge does once for every name instead of each workspace
    # fighting over :80.
    port = 443

    # ONE NAME, ONE WORKSPACE. Both runtimes come through here, so this is the single
    # place the collision can be refused -- and `exclude` already carries the
    # workspace that is allowed to re-claim its own name.
    taken = edgesvc.host_owner(host, excluding=exclude or repro_name)
    if taken:
        raise ConflictError(
            f"{host} is already served for workspace {taken!r}, and the edge routes by "
            f"hostname -- two claims on one name means Traefik picks one and the other "
            f"silently never answers. Use a different name, or `houston down --name "
            f"{taken}` first.")

    return tlsmod.TlsSpec(
        mode=mode, host=host, port=port, acme_email=req.acme_email,
        acme_staging=req.acme_staging, acme_challenge=req.acme_challenge,
        acme_dns_provider=req.acme_dns_provider)


def _route_kubernetes_name(name: str, ktls: _KubeTls, *,
                           emit: Emit = null_emit) -> None:
    """Put the name in front of the cluster. BEFORE the chart, and that is not tidiness.

    An ACME order starts the moment cert-manager sees the Ingress -- which the chart
    creates during `helm install` -- and the http-01 challenge arrives on this host's
    :80. If the edge is not up and the route is not written by then, Let's Encrypt gets
    a connection refused, the order fails, and `wait_for_certificate` spends its whole
    budget on a challenge that could never have been answered. The first version of
    this did exactly that: it published the name AFTER the install and after the
    certificate wait.

    Writing the route early is harmless in the other direction: it points at the
    cluster's ingress, which exists whether or not this workspace does, so the name
    404s from the cluster for the few minutes before its Ingress appears.
    """
    # Imported here rather than at module scope, like every other `k8s` use in this
    # file: `lifecycle` is the Compose-shaped module both front-ends load, and keeping
    # the Kubernetes seam a local import is what stops that becoming a hard dependency.
    from houston.services import k8s as k8s_mod

    if not ktls.cluster_owns_443:
        if not edgesvc.running():
            info(emit, "starting the edge (one Traefik, :80 and :443 for every name)",
                 phase="tls")
            started = edgesvc.ensure_running()
            if not started:
                holder = edgesvc.port_holder(443)
                because = (f" — {holder} is holding :443" if holder
                           else (f" — {started.why}" if started.why else ""))
                warn(emit, f"the edge did not start{because}, so {ktls.host} will not "
                           f"answer yet. The workspace itself is unaffected; free the "
                           f"port and `houston edge start`.", phase="tls")
    if edgesvc.installed():
        # THE EDGE MAY NOT BE ABLE TO REACH THE ENDPOINT YET. A kind cluster's node is
        # a container on kind's own Docker network, so its ingress NodePort answers
        # from the host and not from a container on the default bridge -- measured:
        # 172.18.0.2:30925 reachable from the host and from the `kind` network,
        # unreachable from `bridge`. Joining is the same mechanism `attach` uses for a
        # workspace's network, applied to the cluster's.
        node = k8s_mod.kind_node_container(
            str(getattr(ktls, "context", "") or ""))
        if node:
            net = edgesvc.container_network(node)
            if net and edgesvc.attach_network(net):
                info(emit, f"the edge joined the cluster's Docker network ({net}) — "
                           f"its ingress is not reachable from the default bridge",
                     phase="tls")
        edgesvc.register(name, ktls.host, passthrough=str(ktls.endpoint))
        info(emit, f"{ktls.host} → {ktls.endpoint} ({ktls.endpoint.source}), passed "
                   f"through untouched — TLS terminates in the cluster",
             phase="tls")
    elif ktls.cluster_owns_443:
        info(emit, f"{ktls.host} is served by the cluster's own ingress, which holds "
                   f"this host's :443 — no edge needed", phase="tls")


def _report_what_the_name_serves(cert_ready, emit, ktls, name, seen):
    """What the probe found, in terms the reader can act on: a fallback certificate, nothing serving, or a working name."""
    if seen.get("fallback") and not cert_ready:
        # THE ORDINARY CASE, and it was being reported as the alarming one. An ingress
        # controller serves its OWN default certificate for a name it has no
        # certificate for yet -- so while cert-manager is still working through the
        # ACME order, the cluster answers with exactly the certificate this branch
        # used to blame on "something in front". `cert_ready` is False here, which
        # says plainly that nothing was issued in time.
        #
        # OBSERVED through the GUI on a first workspace on a cold cluster: the image
        # pull ate the certificate window, the wait expired, and the create finished
        # by telling the reader to go looking for a port conflict on their own machine
        # that did not exist. The certificate arrived a minute later.
        warn(emit, f"{ktls.host} is answering with the ingress controller's own "
                   f"default certificate ({seen.get('issuer')}) because cert-manager "
                   f"has not issued one yet — the ACME order is usually still "
                   f"running. The workspace is up. `houston tls-status --name "
                   f"{name}` re-checks it, and `kubectl -n houston-{name} get "
                   f"certificate` says what cert-manager is waiting on.",
             phase="tls")
    elif seen.get("fallback"):
        # The certificate IS issued and the name still answers with somebody's default
        # one, so the cluster is not the thing terminating TLS for it.
        warn(emit, f"{ktls.host} answered with a proxy's own default certificate "
                   f"({seen.get('issuer')}), not the one in the cluster — the "
                   f"certificate was issued, so something in front is terminating TLS "
                   f"for this name instead of passing it through. `houston doctor` "
                   f"names a cluster holding this host's ports.", phase="tls")
    elif not seen.get("serving"):
        warn(emit, f"nothing answered TLS for {ktls.host} yet "
                   f"({seen.get('error') or 'no certificate offered'}). The workspace "
                   f"is up on its port-forward; `houston tls-status --name {name}` "
                   f"re-checks the name.", phase="tls")
    else:
        info(emit, f"https://{ktls.host} is serving the cluster's certificate "
                   f"({seen.get('issuer')})", phase="tls")


def _publish_kubernetes_name(name: str, ktls: _KubeTls, *, cert_ready: bool = True,
                             emit: Emit = null_emit, sleep=time.sleep) -> None:
    """Put the name in front of the cluster, and then CHECK it rather than claim it.

    Two topologies, both normal, and the difference decides whether the edge is
    needed at all:

    * the cluster is already receiving on this host's :443 (k3s ServiceLB) -- the
      name reaches the cluster's own ingress directly, and an edge is not required.
      A route is still registered when one exists, because it costs nothing and it is
      what serves the name over any address the cluster's DNAT does not cover.
    * the cluster is not -- the edge must own :443 and pass the name through by SNI.

    The check at the end is the part that matters. Measured on a box in exactly this
    state: the edge was bound, running, healthy, and answering every https name with
    its own default certificate because the cluster had taken the port underneath it.
    `tls.verify` already reports that as `fallback`, so proving it is one existing
    call rather than a new mechanism -- and a name that does not work must say so at
    create time, not be discovered in a browser.
    """
    from houston import tls as tlsmod

    # Routing happened before the install (`_route_kubernetes_name`); this is only the
    # check. Kept a separate call because the two have opposite ordering needs: the
    # route must exist before the chart creates the Ingress, and the proof cannot mean
    # anything until it does.
    # PROVED, NOT ANNOUNCED -- and polled, because a route being WRITTEN and a proxy
    # having RELOADED it are not the same moment. Verified live: this reported a
    # default certificate for a chain that was entirely correct, and the same name
    # served the cluster's certificate seconds later.
    # ONLY for the local issuer. A Let's Encrypt certificate is checked against the
    # SYSTEM store -- that is the whole claim being made about it -- and houston's own
    # CA may not even exist on a box that has only ever used `--domain`, which is how
    # this was found. `cli.tls_status` already makes exactly this distinction.
    cafile = (str(tlsmod.ca_dir() / tlsmod.CA_CRT)
              if getattr(ktls.issuer, "mode", "local") != "acme" else None)
    seen: dict = {}
    for attempt in range(PUBLISH_PROOF_TRIES):
        seen = tlsmod.verify(ktls.host, 443, cafile=cafile)
        if seen.get("serving") and not seen.get("fallback"):
            break
        if attempt < PUBLISH_PROOF_TRIES - 1:
            sleep(PUBLISH_PROOF_PAUSE)
    _report_what_the_name_serves(cert_ready, emit, ktls, name, seen)


def _refuse_a_name_that_will_not_reach(claim, emit, endpoint, remote_ingress, spec, tlsspec):
    """Every reason this name cannot be served, checked before anything is installed. Each refusal costs one probe and no state."""
    if spec.mode == "acme":
        info(emit, ("the http-01 challenge goes straight to the cluster's own load "
                    f"balancer ({endpoint.address}) — this machine is not in the path"
                    if remote_ingress else
                    "the http-01 challenge will reach the cluster's ingress directly "
                    "— it holds this host's :80"
                    if claim and 80 in (claim.ports or []) else
                    "the http-01 challenge arrives on the edge's :80 and is redirected "
                    "onto the passthrough, which reaches the cluster"),
             phase="tls")
    # WHETHER THIS HOSTNAME REACHES THE CLUSTER, not whether the cluster holds *a*
    # host address. `claim` answers the second question, and the two come apart on
    # exactly the shape this branch is used on: k3s ServiceLB claims :443 at the
    # host's own address, so `claim` said yes -- while `<name>.houston.localhost`
    # resolves to ::1 first, klipper's DNAT is IPv4-only, and the edge is what
    # answers there. houston therefore skipped writing the passthrough route and
    # printed an https URL that returned 404. Measured on this box: the claim is
    # 172.16.0.2 [80,443] while the name resolves to ['::1', '127.0.0.1'].
    #
    # So the claim now has to be true FOR THIS NAME. Getting it wrong in the other
    # direction is cheap -- an unnecessary edge route is a passthrough that forwards
    # to the same ingress -- which is why this is written to fail closed.
    owns = bool(claim and 443 in (claim.ports or []))
    if owns and not _name_reaches(tlsspec.host, claim):
        info(emit, f"{tlsspec.host} does not resolve to the cluster's ingress "
                   f"({claim.address}), so the name is published through the edge "
                   f"rather than straight at the cluster", phase="tls")
        owns = False
    # A REMOTE INGRESS CANNOT BE FRONTED BY A LOCAL EDGE, so there is nothing here to
    # decide. `claim` asks whether the cluster holds THIS HOST's :443, which for any
    # managed cluster is definitionally no -- its ingress is a load balancer in
    # somebody else's data centre, which is the case `IngressEndpoint` already names:
    # "a LoadBalancer address that is NOT one of this host's own -- kind with MetalLB,
    # or any remote cluster". Falling through to the edge for it was not merely
    # wasteful, it was impossible: the workspace's name resolves to that load
    # balancer, so no packet for it ever arrives on this machine.
    #
    # MEASURED against EKS. `up --domain` announced "the http-01 challenge arrives on
    # the edge's :80", tried to start an edge it had no use for, and refused the whole
    # create because a different HOUSTON_HOME on the box already owned one -- a
    # shared support server being exactly what this feature is for.
    return owns


def _install_the_ingress_machinery(asked, context, emit, k8s, plan, pre, req):
    """cert-manager and an ingress controller, and where the cluster is receiving.

    ADOPT WHAT IS THERE, INSTALL WHAT IS NOT -- and this is the FIRST thing on this
    path that changes the cluster, which is why every refusal above it is a read.
    It sat above the cert-manager check once, and a create on a fresh kind box then
    built a cluster, installed Traefik into it, and refused for want of cert-manager:
    a refusal that left an install behind. Measured exactly that way.

    Adopting comes first, and not only to save work: the ingress controller is the
    component a support case is usually about, so a cluster already running nginx
    keeps running nginx. Installing is only for a cluster that has none.

    It raises for the two cases it must not paper over: a read it could not make,
    and a cluster that is not on this machine -- where the chart's LoadBalancer
    Service would provision a billable cloud load balancer implicitly.
    """
    where = pre.distribution or plan.distribution
    # THE GUIDE'S TWO PREREQUISITES, in the order they depend on each other. Both are
    # adopted when the cluster has them and installed with the guide's own command when
    # it does not; both refuse on a cluster that is not on this machine, where CRDs and
    # a LoadBalancer are somebody else's to create; and neither is ever removed.
    #
    # cert-manager first: it is what the ingress annotation will name, and an issuer
    # created before its webhook is serving is accepted and then never reconciled.
    k8s.ensure_cert_manager(context=context, distribution=where, emit=emit)
    ingress_class = k8s.ensure_ingress(context=context, distribution=where,
                                       prefer=req.ingress_class, emit=emit)
    # AFTER `ensure_ingress`, because on a cluster that had none the ingress Service is
    # something houston has just created. Read before it, this found nothing and
    # refused for want of the thing it was about to install.
    endpoint = k8s.ingress_endpoint(context)
    if endpoint is None:
        raise PreflightError(
            f"{asked}: cluster {context!r} has the ingress class {ingress_class!r} but "
            f"no Service publishing :443 that can be reached from outside it, so "
            f"nothing can route to this workspace's name. `kubectl get svc -A` — the "
            f"controller's Service needs to be a LoadBalancer or a NodePort. An "
            f"ingress exposed by a hostPort DaemonSet has none to find.")
    claim = k8s.host_port_claim(context)
    return claim, endpoint, ingress_class


def _probe_the_cluster(emit, k8s, plan, spec):
    """Bring the cluster up if it is ours to, probe it, and refuse a local CA it
    cannot be taught to trust.

    THE CLUSTER HAS TO EXIST BEFORE IT CAN BE ASKED ANYTHING. This used to refuse
    outright when `plan.create` was set -- there was nothing to probe and houston
    installed no ingress controller, so `--https` on a box whose only Kubernetes was
    a not-yet-created kind cluster was a dead end. Now the cluster is brought up
    first and filled in, so the refusal is gone.

    `ensure_kubeconfig` is what creates it, it takes the cluster lock, and it is
    idempotent -- `create_workspace` calls it again later and it short-circuits. The
    cost is stated rather than hidden: with a name asked for, the cluster is created
    slightly earlier than the write-ahead record, so an interrupted create can leave
    a cluster with no workspace. `prune` reclaims a cluster houston made, which is
    what that is for.
    """
    context = k8s.ensure_kubeconfig(plan, emit=emit) if plan.create else plan.context
    pre = k8s.preflight(context)
    # WHERE THE CA KEY WOULD GO. `tls_local.py`: this key "can mint a certificate for
    # any name the browser will trust". On this machine's own cluster that is the same
    # trust boundary as the box. On somebody else's it is not, and there is a better
    # answer that needs no CA at all.
    #
    # ONLY for the local issuer, and that asymmetry is the whole reason `--domain` is
    # the answer this refusal points at: an ACME issuer holds a Let's Encrypt account
    # key, which is the cluster's own and mints nothing this box trusts. So `--domain`
    # works against a cluster anywhere, and `--https` does not.
    if spec.mode == "local" and \
            not k8s.is_local_cluster(pre.distribution or plan.distribution):
        raise AuthorityGateError(
            f"--https would copy houston's CA private key into a Secret in cluster "
            f"{context!r}, which is not on this machine "
            f"({pre.distribution or plan.distribution or 'unknown'}). That key can "
            f"mint a certificate for any name this box trusts, so it does not leave "
            f"here. Use --domain for a publicly-trusted certificate instead, or "
            f"reach the workspace on its port-forward.",
            code="GATE_UNAPPROVED_CLUSTER")
    return context, pre


def _kubernetes_tls_plan(req: CreateReq, tlsspec, plan, *,
                         emit: Emit = null_emit) -> _KubeTls:
    """Refuse, or return what the ingress needs. Reads only; writes nothing.

    Every refusal here costs one probe and no state. That ordering is the point: an
    `up --https` that cannot work should say so in a second, not after four minutes
    of MongoDB and a chart install.
    """
    from houston import tls as tlsmod
    from houston.services import k8s

    # Both modes are honoured now, and they are the same code path with a different
    # ClusterIssuer -- which is what the official values.yaml already implies.
    spec = k8s.IssuerSpec(mode=("acme" if tlsspec.mode == tlsmod.MODE_ACME
                                else "local"),
                          acme_email=tlsspec.acme_email,
                          acme_staging=tlsspec.acme_staging)
    # Which request every refusal below is about. Defined here, beside the spec it is
    # derived from, because the first refusal comes before the cluster is even probed.
    asked = "--domain" if spec.mode == "acme" else "--https"
    context, pre = _probe_the_cluster(emit, k8s, plan, spec)
    claim, endpoint, ingress_class = _install_the_ingress_machinery(
        asked, context, emit, k8s, plan, pre, req)
    # HOW THE CHALLENGE GETS IN, said rather than discovered. cert-manager implements
    # http01 and dns01 and NOT tls-alpn, so a public name needs Let's Encrypt to reach
    # :80 for it. Two ways that happens, both measured:
    #
    #   * the cluster holds host :80 itself (k3s ServiceLB) -- the challenge arrives
    #     at its ingress directly. Proven end to end with a real production
    #     certificate.
    #   * the edge holds :80 -- it answers 301 to https on the same host and path, and
    #     that lands on the SNI passthrough, which reaches the cluster. Let's Encrypt
    #     follows an http-01 redirect and does not validate the target's certificate,
    #     so this works even before any certificate exists. Both halves measured
    #     (a 301 preserving the path; the challenge path served 200 through the
    #     passthrough from a cert-manager-shaped solver Ingress with no `tls:` block).
    #
    # No third case is refused, because a box where neither holds :80 has nothing
    # listening on it and the failure is a plain connection refused that Let's Encrypt
    # reports itself. Saying which of the two applies is worth more than a guard.
    #   * the cluster's ingress is somewhere else entirely -- a managed cluster's load
    #     balancer. The name resolves to IT, so the challenge arrives there and this
    #     machine is not in the path at any point.
    remote_ingress = endpoint is not None and not endpoint.local
    owns = _refuse_a_name_that_will_not_reach(claim, emit, endpoint, remote_ingress, spec, tlsspec)
    if not owns and remote_ingress:
        owns = True
    return _KubeTls(host=tlsspec.host, ingress_class=ingress_class,
                    endpoint=endpoint, issuer=spec, context=context,
                    cluster_owns_443=owns)
