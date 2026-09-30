"""HTTPS on this box: `edge` `trust-ca` `tls-status`.

One Traefik holds :80/:443 for the whole machine and a workspace gains or loses HTTPS by
a route file appearing or disappearing -- none of it is in any workspace's compose file,
which is why these three exist as commands at all rather than as flags on `up`.

`tls-status` reports what is ACTUALLY being served, which is not the same question as
what was configured: it branches on where TLS terminates, because on a Kubernetes
workspace probing loopback reaches houston's own edge, which has never heard of the
name, and a healthy workspace was once reported as broken exactly that way.
"""
from __future__ import annotations

import time

import typer

from houston import config, errors, runner, ui
from houston.services import topology
from houston.cli._common import (_port_claim_note,
                                 _err, _fail, _promote_command, _resolve_name, _run_and_echo)


def _report_gui_tls(domain: str, tries: int = 10, pause: float = 2.0) -> None:
    """Say whether `domain` is really being served over TLS yet, and why not.

    Polled rather than asked once: ACME takes a few seconds on a good day, so a single
    probe would report "not yet" for every healthy start and teach people to ignore it.
    Never fatal -- the GUI is about to serve, and a certificate that has not arrived is
    a thing to say rather than a reason to refuse.
    """

    from houston import tls as tlsmod
    from houston.services import edge as edgesvc

    # BEFORE the wait, not after it. With a cluster holding the ports no challenge of
    # any kind can complete, so the twenty seconds of "waiting for the certificate…"
    # were spent teaching the reader that this message means nothing.
    claim = _port_claim_note()
    if claim:
        ui.warn(f"  ⚠ https://{domain} cannot get a certificate — {claim}")
        return

    for attempt in range(tries):
        got = tlsmod.verify("127.0.0.1", 443, sni=domain, timeout=5.0)
        if got.get("serving") and not got.get("fallback"):
            ui.ok(f"https://{domain} is serving a real certificate "
                  f"({got.get('issuer', '')})".rstrip(" ()"))
            return
        why = edgesvc.acme_failure(domain)
        if why:
            # Conclusive: Let's Encrypt has answered and said no. Stop waiting.
            ui.warn(f"  ⚠ https://{domain} has NO certificate yet, and Let's Encrypt "
                    f"refused:\n      {why}")
            ui.hint(f"  The GUI itself is fine — this is the name, not the server. "
                    f"Check that {domain} resolves to this host's public address and "
                    f"that :443 is reachable from the internet (houston validates over "
                    f"TLS-ALPN on 443, not :80), then `houston edge restart`.")
            ui.hint("  Full detail: `houston edge logs --tail 50`")
            return
        if attempt < tries - 1:
            if attempt == 0:
                ui.note(f"  waiting for the certificate for {domain}…")
            time.sleep(pause)
    ui.warn(f"  ⚠ https://{domain} is not serving a real certificate yet. Traefik "
            f"requests it in the background, so this may still complete.")
    ui.hint("  Watch it: `houston edge logs -f`   ·   check it: `houston tls-status`")


def _edge_route_host(edgesvc, name: str) -> str:
    """The hostname a route file serves, for display only. `?` when it declares none.

    `edge.route_host` already matched both rule shapes and this kept its own copy
    testing `"Host(" in line` -- which is NOT a substring of `"HostSNI("`, so every
    Kubernetes passthrough route displayed as having no host while serving 200 from
    the internet. The GUI had the identical copy, so the two agreed, which is what
    made it read as a fact about the route rather than about the parser.
    """
    return edgesvc.route_host(name) or "?"


def _edge_start(action, edgesvc):
    """Bring the front door up, and say what it is now holding."""
    if action in ("start", "restart"):
        # RENDERED, not raised. `up()` refuses with a ConflictError when an edge from
        # a different HOUSTON_HOME already holds the port -- a real, expected,
        # actionable condition, and starting this one would take that one's names
        # down. Uncaught here, so `houston edge start` answered a two-user box with
        # a Python TRACEBACK, source of cli.py included. `serve` learned this
        # already; this path is the same call and did not.
        try:
            started_ok = edgesvc.up(pull=False).returncode == 0
        except errors.ReproError as exc:
            _fail(exc)
        if not started_ok:
            _err("the edge did not start. Check nothing else holds :80 or :443:\n"
                 "    sudo lsof -i :443")
        # BOUND IS NOT REACHABLE. See `_port_claim_note`: this line claimed every
        # name was served again on a box where a cluster was taking every packet
        # before Docker saw it, which is the state this whole check exists for.
        claim = _port_claim_note()
        if claim:
            ui.warn(f"  ⚠ edge running, but NOT reachable — {claim}")
        else:
            ui.ok("✓ edge running — every registered name is served again.")


def _edge_lifecycle(action, edgesvc):
    """`edge start|stop|restart`: move the front door without losing its routes."""
    if not edgesvc.installed() and action != "stop":
        edgesvc.write(edgesvc.Edge())
    elif action in ("start", "restart"):
        # RE-RESOLVE FROM CONFIG. `start` used to just `up` the compose file that was
        # already on disk, so a changed `acme.challenge` or `acme.staging` reached
        # nothing -- the container came back with the challenge and the CA it was
        # created with, and the log went on reporting the same failure. Measured:
        # `config set acme.challenge http` then `edge restart` still validated over
        # TLS-ALPN against the production CA.
        #
        # Rebuilt from the recorded spec, which is why the spec is recorded: the
        # older reconstruction knew only the domain, so regenerating from it would
        # have lost the GUI's host and port and pointed the front door at nothing.
        fd = edgesvc.current()
        if fd is not None:
            edgesvc.write(edgesvc.Edge.resolve(
                fd.domain, fd.acme_email,
                gui_host=fd.gui_host, gui_port=fd.gui_port,
                http_port=fd.http_port, https_port=fd.https_port))
    if action in ("stop", "restart"):
        # NOTHING TO STOP IS NOT A FAILURE, AND NOT A SUCCESS EITHER. `edge logs`
        # a few lines up already guards on `installed()`; this did not, so on a
        # home that has never had an edge it went straight to `docker compose` in
        # a directory that does not exist. Only `stop` can reach this with no edge:
        # `restart` writes a config above.
        if not edgesvc.installed():
            ui.note("no edge is set up in this home — nothing to stop. If a name "
                    "is still being served, the edge belongs to another "
                    "HOUSTON_HOME; `houston edge status` says so.")
            return
        # AND THE EXIT CODE IS READ. This discarded it and printed success
        # unconditionally, which is the shape this codebase keeps finding: a
        # compose that could not run at all reported the ports as free.
        if edgesvc.down() != 0:
            _err("could not stop the edge — `docker compose -p houston_edge ps` "
                 "says what is still there.")
        # NOT "the ports are free". The edge no longer holds them, which is all
        # this command did; a cluster taking them by DNAT would make the stronger
        # claim false, and that is the exact failure `_port_claim_note` exists for.
        ui.ok("✓ edge stopped; it no longer holds :80 or :443.")
    _edge_start(action, edgesvc)
    return


def _report_acme_deletion(edgesvc, gone):
    """Whether the certificate is really gone, which depends on who is running Traefik."""
    if gone["acme"]:
        ui.ok(f"✓ Let's Encrypt certificate removed from {', '.join(gone['acme'])}")
        if gone["foreign"]:
            # The one case where a clean "removed" would mislead: this home's
            # edge is not running, another home's is, and that one reads its own
            # ACME store. The key came off this disk; the name is still served.
            ui.warn(f"the edge holding :443 belongs to another HOUSTON_HOME "
                    f"({gone['foreign']}), and it reads its OWN certificate "
                    f"store — so what was just deleted is this home's copy, not "
                    f"the certificate that name is being served with. Run this "
                    f"there, with that HOUSTON_HOME.")
        elif gone["restarted"] is True:
            ui.note("the edge was restarted so Traefik reloads the store — it holds "
                    "it in memory and rewrites the whole file, so an edit made "
                    "underneath it comes back. Every other name is served again; "
                    "routes are files.")
        elif gone["restarted"] is False:
            ui.warn("the edge did not come back cleanly — `houston edge status`. "
                    "Until it restarts, Traefik may write the deleted entry back "
                    "from memory.")
        elif not edgesvc.running():
            ui.hint("the edge is stopped, so nothing can write the entry back.")


def _edge_delete(edgesvc, host, yes):
    """`edge delete`: forget one name, with the refusals that protect a live one."""
    if not edgesvc.installed():
        ui.note("no edge in this home, so it holds no names — nothing to delete.")
        return
    if not host:
        _err("name the host: `houston edge delete <host>`. `houston edge status` "
             "lists what this edge routes and what it holds a certificate for.")
    if not yes:
        # The prompt names what goes, because "delete rc-rpro-test.kestron.org"
        # reads like removing a route and it is removing a private key.
        typer.confirm(
            f"delete {host} — its route, its certificate, its PRIVATE KEY and its "
            f"Let's Encrypt entry? This cannot be undone",
            abort=True)
    try:
        gone = edgesvc.delete_host(host, confirm=True)
    except errors.ReproError as exc:
        _fail(exc)
    # Reported per kind, and only what actually went. Saying "certificate removed"
    # about a Kubernetes name whose certificate lives in the cluster would be the
    # same reported-the-attempt-as-the-outcome failure `edge stop` had.
    for name in gone["routes"]:
        ui.ok(f"✓ route {name} removed"
              + (" (passthrough — its certificate is in the cluster, and went "
                 "with the namespace)" if name in gone["passthrough"] else ""))
    if gone["certificate"]:
        ui.ok(f"✓ certificate and key for {gone['host']} removed")
    if gone["declaration"]:
        ui.ok(f"✓ certificate declaration for {gone['host']} removed")
    _report_acme_deletion(edgesvc, gone)
    if not any((gone["routes"], gone["certificate"], gone["declaration"],
                gone["acme"])):
        ui.note(f"nothing here for {gone['host']} — no route, no certificate, no "
                f"ACME entry. Already clean, or the name belongs to another "
                f"HOUSTON_HOME.")
        return
    if gone["kept"]:
        ui.hint(f"kept {', '.join(gone['kept'])} — the issuance ledger is what "
                f"`tls-status` counts against Let's Encrypt's five-a-week "
                f"duplicate limit. Deleting the certificate does NOT give the "
                f"budget back; re-issuing the same name still counts.")
    return


def _report_stray_certificates(domain, edgesvc, st):
    """Certificates and ACME entries no route claims any more."""
    # Declared and unservable, which is silent apart from a log nobody was
    # pointed at. Reported BEFORE the early return below, or the box where it
    # matters most -- one with a GUI name and no workspace routes -- never shows it.
    orphans = edgesvc.orphan_certs()
    if orphans:
        ui.warn(f"  ⚠ {len(orphans)} name(s) declared with no certificate file — "
                f"{', '.join(orphans[:3])}{'…' if len(orphans) > 3 else ''}. Traefik "
                f"logs 'failed to find any PEM data' for each, once a second, and "
                f"serves none of them. `houston edge logs`; if "
                f"{edgesvc.certs_dir()} is root-owned (Docker creates a missing "
                f"bind-mount target that way), `sudo chown -R $(id -u):$(id -g) "
                f"{edgesvc.certs_dir()}` and re-run `up` for those workspaces.")
    # Certificates with nothing pointing at them. The counterpart to the orphan
    # check above and the other half of the same blind spot: that one finds a
    # declaration with no certificate, this finds a certificate with no route.
    # Reported because a name cannot be cleaned up until it can be SEEN -- a
    # Let's Encrypt key for a customer-shaped hostname sitting in acme.json for
    # ever was invisible to every command this tool had.
    claimed = {_edge_route_host(edgesvc, n).casefold() for n in st["routes"]}
    claimed.add((domain or "").casefold())
    stale = [h for h in edgesvc.acme_hosts() if h.casefold() not in claimed]
    if stale:
        ui.warn(f"  ⚠ {len(stale)} certificate(s) held with no route — "
                f"{', '.join(stale[:3])}{'…' if len(stale) > 3 else ''}. Each is a "
                f"Let's Encrypt certificate AND private key on this disk for a name "
                f"nothing serves. `houston edge delete <host>` removes one.")


def _edge_status(edgesvc, host):
    """`edge status`: what the front door is serving, and for whom."""
    st = edgesvc.status()
    if not st["installed"]:
        ui.note("no edge yet — it starts with the first `--https` or `--domain` "
                "workspace.")
        return
    domain = edgesvc.served_domain()
    rows = [("State", "running" if st["running"] else "STOPPED"),
            ("Project", f"{edgesvc.PROJECT} ({edgesvc.edge_dir()})")]
    if domain:
        rows.append(("GUI name", domain))
    ui.panel("houston edge", rows)
    if not st["running"]:
        ui.warn("  ⚠ every https name on this box is unreachable while it is "
                "stopped — `houston edge start`")
    else:
        # "running" was the whole answer here, and running is not reachable. The
        # box that took two days to diagnose printed State: running, 3 routes, and
        # served none of them. Same note as the start path, one place it is written.
        claim = _port_claim_note()
        if claim:
            ui.warn(f"  ⚠ running but NOT reachable — {claim}")
    _report_stray_certificates(domain, edgesvc, st)
    if not st["routes"]:
        ui.hint("  no names registered yet.")
        return
    # Attachment and route side by side: a route whose network the edge never
    # joined is a 502, not an error, and that is the hardest failure to read.
    attached = set(st["attached"])
    typer.echo(f"\n{'NAME':<28} {'SERVES':<38} REACHABLE")
    for name in st["routes"]:
        host = _edge_route_host(edgesvc, name)
        # Through the service, so this and `/api/edge` cannot disagree again: a
        # PASSTHROUGH route joins no workspace network, so membership answered
        # NO (502) for every Kubernetes workspace, including ones serving 200
        # from the internet on a real certificate.
        ok = edgesvc.route_reachable(name, attached)
        typer.echo(f"{name:<28} {host:<38} {'yes' if ok else 'NO (502)'}")
    return


def edge_cmd(
    action: str = typer.Argument("status", help="status | start | stop | restart | logs | delete"),
    host: str = typer.Argument("", help="the hostname, for `delete`"),
    follow: bool = typer.Option(False, "--follow", "-f", help="follow the log (logs)"),
    tail: int = typer.Option(200, "--tail", help="how many lines of log to show"),
    yes: bool = typer.Option(False, "--yes", "-y", help="skip the confirmation prompt (delete)"),
) -> None:
    """The shared Traefik that serves every HTTPS name on this box.

    It is not a workspace, so it never appears in `list` and `prune`/`down` cannot
    touch it — but something holding :443 and routing your traffic should be
    answerable, and this is where it answers.

    It starts by itself when the first workspace needs a name. `stop` frees :80
    and :443 for something else; routes are files, so starting it again restores
    every name with no re-registration.

    `delete <host>` forgets a name completely — its route, its certificate, its
    private key and its Let's Encrypt entry. `down --volumes` removes the route
    and stops there, so the certificate material for a name you are finished with
    outlives the workspace it was issued for; this is how it goes.
    """
    from houston.services import edge as edgesvc

    if action == "logs":
        # WHERE HTTPS FAILS, and there was no way to read it from here. Traefik requests
        # certificates in the background after it starts, so a name can be routed and the
        # edge healthy while issuance fails, and this is the only record of why.
        if not edgesvc.installed():
            ui.note("no edge yet — nothing to show. It starts with the first `--https` "
                    "or `--domain` workspace, or `serve --domain`.")
            return
        if not edgesvc.running():
            ui.warn("the edge is STOPPED — this is whatever it said before it stopped. "
                    "`houston edge start`")
        raise typer.Exit(edgesvc.logs(tail=tail, follow=follow))

    if action == "status":
        return _edge_status(edgesvc, host)

    if action == "delete":
        return _edge_delete(edgesvc, host, yes)

    if action in ("start", "stop", "restart"):
        return _edge_lifecycle(action, edgesvc)

    _err(f"unknown action {action!r} (want: status | start | stop | restart | logs | "
         f"delete <host>)")


def _tls_troubleshoot(m: runner.Metadata, mode: str, host: str, port: int) -> None:
    """The next things to actually check, ordered by how often they are the cause."""

    ui.hint(f"  Rocket.Chat itself is fine at {m.root_url} - this is the TLS layer.")
    # A KUBERNETES WORKSPACE'S CERTIFICATE IS NOT THE EDGE'S, so none of the advice
    # below applies to it. Every line here named Traefik and `houston logs` -- which
    # on this runtime shows Rocket.Chat, not a proxy -- and the tlsalpn/Cloudflare
    # branch is about a challenge cert-manager does not even implement. Sending
    # someone to `edge logs` for a certificate the edge never saw is the whole reason
    # this branch exists.
    if topology.of_meta(m) == topology.KUBERNETES:
        extra = m.extra if isinstance(m.extra, dict) else {}
        ns = str(extra.get("namespace") or m.project or "")
        from houston.services import k8s
        ui.hint("  TLS terminates in the cluster, from a Secret cert-manager filled — "
                "the edge only forwards the raw connection, so its log has nothing "
                "about this name.")
        ui.hint("  Most likely, in order:")
        ui.hint("    1. the Certificate is not Ready yet, or says why it is not")
        ui.hint("    2. the ClusterIssuer is not Ready (created before cert-manager, "
                "or no egress for an ACME order)")
        ui.hint("    3. nothing routes to the ingress — `houston doctor` names a "
                "cluster holding this host's ports")
        ui.hint("  What cert-manager says:")
        ui.hint(f"    kubectl -n {ns} describe certificate {k8s.tls_secret_for(m.name)}")
        ui.hint(f"    kubectl describe clusterissuer "
                f"{k8s.ACME_ISSUER if mode == 'acme' else k8s.CA_ISSUER}")
        if mode == "acme":
            ui.hint(f"    kubectl -n {ns} get order,challenge")
            ui.hint("  Debug on staging (`houston config set acme.staging true`): "
                    f"production allows only 5 failed validations per hour for {host}.")
        return
    if mode == "acme":
        ui.hint("  Most likely, in order:")
        ui.hint(f"    1. inbound TCP/{port} not reachable from the internet "
                "(cloud security group / host firewall)")
        ui.hint(f"    2. DNS: `dig +short {host}` must return this host's PUBLIC IP")
        ui.hint("    3. behind Cloudflare's orange cloud? it terminates TLS, so "
                "tlsalpn cannot work - put a provider token in "
                "~/.houston/acme/dns.env to switch to dns-01")
        ui.hint(f"  What Traefik says:  houston logs --name {m.name} | grep -i acme")
        ui.hint("  Debug on staging (--acme-staging): production allows only 5 failed "
                f"validations per hour for {host}.")
    else:
        ui.hint(f"  Check Traefik started:  houston logs --name {m.name} | grep -i traefik")


def _render_tls_panel(host, m, mode, port, r):
    """The certificate actually being served, and the fallback that means nobody claimed the name."""
    # SUBJECT OR THE NAMES, because an empty subject is not a failure to read one.
    # cert-manager issues with no subject at all -- the name is in the SANs only -- so
    # every Kubernetes workspace showed `Subject: ?` for a certificate that was
    # entirely correct, which reads as something having gone wrong.
    rows = [("Endpoint", f"{host}:{port}"), ("Issuer", r["issuer"] or "?"),
            ("Valid for", r["subject"] or ", ".join(r.get("names") or []) or "?"),
            ("Expires", r["dates"].replace("notAfter=", ""))]
    ui.panel(f"TLS: {m.name}", rows)

    if r["fallback"]:
        # The ingress controller's own placeholder: it started, and has no certificate
        # for this name YET. "ACME never succeeded" is a claim about the past that this
        # check cannot make -- on a fresh cluster this is the ordinary state for the
        # first minute or three, and reporting it as permanent sends somebody hunting a
        # problem that resolves itself while they read the logs. The exit code stays
        # non-zero: whatever the cause, this name is not serving a real certificate now.
        ui.warn("  ✗ this is the ingress controller's built-in placeholder "
                "certificate — cert-manager has not issued one for this name yet.")
        ui.note("    On a fresh cluster that is normal for the first minute or three. "
                "Run this again; if it persists, the ACME order is stuck.")
        _tls_troubleshoot(m, mode, host, port)
        raise typer.Exit(1)


def _explain_self_signed_acme(host, m, mode, r, tlsmod):
    """An ACME name being served a self-signed certificate is a specific, fixable state."""
    # THREE reasons an ACME certificate is untrusted, and they were all reported as
    # the first one. Staging is expected and fine; a self-signed certificate means
    # nothing has issued one yet, which on a cluster is the normal state for the first
    # minutes and is not a failure either; anything else is a real surprise.
    if mode == tlsmod.MODE_ACME and r.get("self_signed"):
        ui.warn("  ✗ serving a self-signed certificate — nothing has issued one yet.")
        ui.hint("  On Kubernetes the ingress serves its own until cert-manager "
                "finishes, which is a minute or three after the workspace answers.")
        ui.hint(f"  kubectl -n houston-{m.name} describe certificate {m.name}-tls")
    elif mode == tlsmod.MODE_ACME and r.get("staging"):
        ui.ok("  ✓ serving HTTPS with a real Let's Encrypt-issued certificate.")
        ui.hint("  Not trusted here, which is normal for --acme-staging: DNS and the "
                "challenge both worked.")
        ui.hint("  For a trusted certificate, re-run the SAME command without "
                "--acme-staging:")
        ui.hint("    " + _promote_command(m, host))
    elif mode == tlsmod.MODE_ACME:
        ui.warn(f"  ✗ serving a certificate this machine does not trust, from "
                f"{r['issuer'] or 'an unnamed issuer'}.")
        ui.hint("  That is neither staging nor a placeholder, so something else is "
                "answering for this name — a proxy in front is the usual cause.")
    else:
        ui.ok("  ✓ serving HTTPS.")
        ui.hint("  This machine does not trust the issuer; that may be fine if the "
                "clients that matter do.")


def _explain_local_ca_mode(host, m, mode, port, r):
    """What a local-CA workspace needs before a browser will trust it."""
    # Two separate facts: is it OUR certificate, and has trust-ca been run?
    if not r["trusted_via_ca"]:
        ui.warn("  ✗ serving a certificate that does not chain to houston's CA.")
        _tls_troubleshoot(m, mode, host, port)
        raise typer.Exit(1)
    ui.ok("  ✓ serving HTTPS with houston's local CA.")
    if r["trusted"]:
        ui.hint("  This machine trusts it — `trust-ca` has been run; no browser warnings.")
    else:
        ui.hint("  Not trusted by this machine yet. Run `houston trust-ca` once to "
                "silence browser warnings (the warning itself is harmless locally).")
    return


def _explain_acme_mode(host, mode, r, tlsmod):
    """What an ACME workspace's certificate state means."""
    # For a real domain, also report what the PUBLIC name serves. If a proxy sits in
    # front (Cloudflare's orange cloud), that is a different certificate from ours,
    # and saying so beats letting the two be confused for each other.
    if mode == tlsmod.MODE_ACME:
        pub = tlsmod.verify(host, 443)
        if not pub["serving"]:
            ui.warn(f"  ⚠ {host}:443 is not reachable from here ({pub['error']}) — "
                    "this host serves TLS, but the public name does not resolve to it "
                    "or nothing forwards to it.")
        elif pub["issuer"] and pub["issuer"] != r["issuer"]:
            ui.warn(f"  ⚠ {host} is fronted by something else: it serves a certificate "
                    f"issued by {pub['issuer']!r}, not the one this host serves "
                    f"({r['issuer']!r}).")
            ui.hint("  That is what an orange-clouded Cloudflare record looks like. "
                    "Clients get the proxy's certificate, not this one.")


def _probe_tls_endpoint(cafile, host, m, port, tlsmod):
    """Ask THIS host, on both loopback families, what it is really serving."""
    # Probe THIS host, not the hostname, so a proxy in front cannot answer for us.
    # Checking only the public name reported Cloudflare's edge certificate as
    # "serving HTTPS, trusted" while our own Traefik had no certificate at all.
    #
    # BOTH LOOPBACK FAMILIES, because one of them may not be ours. On a box running
    # k3s, klipper's ServiceLB DNATs IPv4 :443 into the cluster -- and its ingress is
    # also Traefik, so probing 127.0.0.1 reached the CLUSTER's placeholder
    # certificate and reported a perfectly healthy workspace as broken. Measured
    # here: 127.0.0.1:443 answered `CN = TRAEFIK DEFAULT CERT` while [::1]:443 --
    # the houston edge -- served the real one, and `tls.verify` on the NAME agreed
    # with [::1]. The advice printed with it was wrong twice over, because it named
    # ACME for a workspace whose certificate comes from the local CA.
    #
    # The first answer that is not a fallback wins; if every family answers with a
    # placeholder then that IS the finding, and the last result carries it.
    #
    # ALL OF THAT IS ABOUT A WORKSPACE THIS BOX TERMINATES TLS FOR. On Kubernetes it
    # is not one: the certificate is a Secret in the cluster, the cluster's own
    # ingress holds :443, and the create says so in as many words -- "this machine is
    # not in the path". Probing loopback there reaches whatever ELSE is listening on
    # this box's :443, which on a machine running houston's own edge is a Traefik
    # that has never heard of the name and answers with its placeholder.
    #
    # MEASURED against a live EKS workspace: `openssl s_client` and `curl` both got a
    # real Let's Encrypt certificate for the name from this very box, `curl` reported
    # `ssl_verify_result: 0`, and `tls-status` said "the ingress controller's built-in
    # placeholder certificate ... the ACME order is stuck" -- a healthy workspace
    # reported as broken, which is the failure this command exists to prevent.
    #
    # So the NAME is what gets probed when TLS terminates elsewhere. The proxy-in-front
    # concern the loopback probe exists for does not apply: there is no "us" on this
    # host to be answered for.
    if str(m.extra.get("tls_terminates") or "") == "cluster":
        r = tlsmod.verify(host, port, cafile=cafile)
    else:
        for _probe in ("127.0.0.1", "::1"):
            r = tlsmod.verify(_probe, port, cafile=cafile, sni=host)
            if r["serving"] and not r.get("fallback"):
                break
    return r


def tls_status(name: str = typer.Option("", "--name", "-n")) -> None:
    """Report what is ACTUALLY being served over HTTPS for a repro.

    `up --wait` only proves Rocket.Chat booted -- it polls the internal http port.
    Traefik obtains certificates in the background AFTER it starts and falls back
    to a self-signed dummy when ACME fails, so a repro can look ready while HTTPS
    serves nothing usable. This makes the real TLS connection and says so.
    """
    from houston import tls as tlsmod
    from houston.services import edge as edgesvc

    # THE GUI'S OWN NAME, when no workspace was asked for. `serve --domain` gives this
    # box an https name that is not a workspace, so `tls-status` -- the one command whose
    # entire job is "what is actually being served for this name" -- answered "no name
    # given and no default repro set". That is the exact question somebody has when their
    # GUI works on :7070 and not on its domain, and there was no command for it.
    if not name and not config.load_config().get("default"):
        gui_domain = edgesvc.served_domain()
        if gui_domain:
            ui.note(f"Checking the GUI's own name, {gui_domain} "
                    f"(no workspace given; `--name <n>` for one)")
            _report_gui_tls(gui_domain, tries=1, pause=0)
            raise typer.Exit(0)

    m = runner.read_meta(_resolve_name(name))
    if not m.public_url:
        ui.warn(f"  ⚠ {m.name!r} was not created with --https - it serves plain HTTP "
                f"at {m.root_url}.")
        raise typer.Exit(1)

    mode = str(m.extra.get("tls") or "")
    host = m.public_url.split("://", 1)[1].split(":")[0]
    # An edge-served workspace publishes no TLS port of its own, so tls_ports is
    # absent OR an empty list (adoption clears it). `[0]` on the empty list was an
    # IndexError -- a traceback from `tls-status` on exactly the workspaces the
    # edge serves, which is all of them now.
    claimed = [int(p) for p in (m.extra.get("tls_ports") or []) if str(p).isdigit()]
    port = claimed[0] if claimed else 443
    cafile = str(tlsmod.ca_dir() / tlsmod.CA_CRT) if mode == tlsmod.MODE_LOCAL else None
    typer.echo(f"Checking {m.public_url} ...")

    r = _probe_tls_endpoint(cafile, host, m, port, tlsmod)

    if not r["serving"]:
        ui.warn(f"  ✗ nothing is serving TLS on this host's port {port} - {r['error']}")
        _tls_troubleshoot(m, mode, host, port)
        raise typer.Exit(1)
    _render_tls_panel(host, m, mode, port, r)

    _explain_acme_mode(host, mode, r, tlsmod)
    if mode == tlsmod.MODE_LOCAL:
        return _explain_local_ca_mode(host, m, mode, port, r)
    if r["trusted"]:
        ui.ok("  ✓ serving HTTPS with a certificate this machine trusts.")
        return
    _explain_self_signed_acme(host, m, mode, r, tlsmod)


def trust_ca(
    uninstall: bool = typer.Option(False, "--uninstall", help="remove it again"),
    show: bool = typer.Option(False, "--show", help="just print the CA path and fingerprint"),
) -> None:
    """Install houston's local CA so `--https` repros are trusted without warnings.

    Only needed for `up --https` on its own (the local-CA mode). A Let's Encrypt
    or self-supplied certificate is already trusted, so this does nothing for those.
    """
    from houston import tls_local
    key, crt = tls_local.ensure_ca()
    if show:
        typer.echo(f"CA certificate: {crt}")
        typer.echo(f"CA key:         {key}  (keep private)")
        _run_and_echo(["openssl", "x509", "-in", str(crt), "-noout",
                       "-subject", "-fingerprint", "-sha256", "-dates"])
        return
    try:
        installed, how = tls_local.trust(crt, uninstall=uninstall)
    except errors.ReproError as exc:
        _fail(exc)
    if installed:
        ui.ok(f"✓ CA {'removed from' if uninstall else 'installed into'} {how}.")
        ui.hint("  Restart the browser to pick it up. Firefox keeps its own store — "
                "if it still warns, import the CA under Settings → Privacy → Certificates.")
    else:
        ui.warn(f"  ⚠ could not {'remove' if uninstall else 'install'} it automatically "
                f"on this platform ({how}).")
        typer.echo(tls_local.manual_trust_instructions(crt, uninstall=uninstall))
