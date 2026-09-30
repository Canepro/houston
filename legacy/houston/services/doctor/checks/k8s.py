"""The cluster: tools, reachability, storage, ingress, metrics, cloud.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import config, runner
from houston.services.doctor.probes import (inotify_headroom)

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "kubernetes"


def _report_certmanager_and_endpoints(k8s, line, pre):
    """Whether TLS can be issued, and what address a workspace would actually answer on."""
    # ASKED ONCE. This is a CRD read against a remote API server -- 1.7s
    # on a live EKS cluster -- and it was made twice within twenty lines,
    # here and again for the https summary below, which cannot disagree
    # with itself between the two.
    try:
        _cm = k8s.cert_manager_installed(pre.context)
    except Exception:  # noqa: BLE001 - a check must not break the report
        _cm = False
    if _cm:
        line(SUBJECT, "ok", "cert-manager: installed — a Certificate can be issued "
                   "in this cluster", check="kubernetes-cert-manager")
    else:
        line(SUBJECT, "ok", "cert-manager: not installed — installed on first use "
                   "by a workspace that asks for a certificate, with the "
                   "guide's own `kubectl apply`",
             check="kubernetes-cert-manager")
    # ONE ROW THAT ANSWERS "CAN THIS BOX SERVE A NAME, AND HOW". Everything
    # in it is reported somewhere above -- the ingress class, the load
    # balancer, the edge, the port claim -- and reading four rows and
    # composing them is exactly what nobody does at the moment they need
    # the answer. This says which of the two shapes the box is in, which is
    # the fact every HTTPS question turns on.
    try:
        _ep = k8s.ingress_endpoint(pre.context)
    except Exception:  # noqa: BLE001 - a check must not break the report
        _ep = None
    if _ep is None:
        line(SUBJECT, "ok", "https: not servable yet — this cluster publishes no "
                   ":443 Service reachable from outside it. A workspace "
                   "that asks for a name installs an ingress controller; "
                   "port-forward needs none",
             check="kubernetes-https")
    else:
        _owner = ("the CLUSTER's own ingress" if _ep.local and _ep.port == 443
                  else "houston's edge")
        _via = ("directly" if _ep.local and _ep.port == 443
                else f"passed through by SNI to {_ep}")
        # THE TWO ROWS MUST NOT SEEM TO DISAGREE. This said "TLS
        # terminates in the cluster, from a cert-manager Secret" directly
        # under a row saying cert-manager was not installed -- describing
        # what WOULD happen as though it already did.
        _where = ("TLS terminates in the cluster, from a cert-manager "
                  "Secret" if _cm else
                  "a name would be servable here once cert-manager is "
                  "installed")
        line(SUBJECT, "ok", f"https: {_owner} answers this host's :443, and a "
                   f"workspace name is served {_via} — {_where} "
                   f"({_ep.source} {_ep}, {_ep.service})",
             check="kubernetes-https")


def _cluster_addons(k8s, line, pre):
    """Helm, cert-manager and the endpoints a workspace would be reached on."""
    # A FACT like the four above it, for the same reason: HTTPS on this
    # runtime needs an issuer in the cluster, and nothing else does.
    #
    # THE CHART, RESOLVED THROUGH THE HOME THE INSTALL WILL USE. `helm_env`
    # keeps houston's Helm state separate, and for a while the repo was
    # added to that home while the install read the user's -- so `up` died
    # at 60% with "Error: repo rocketchat not found" on a box where `helm
    # repo list` looked fine. Asked here the same way, so the answer is
    # about the same home.
    try:
        _repo = k8s.kube.run(["helm", "search", "repo", k8s.CHART, "-o", "json"],
                        env=k8s.helm_env(pre.context))
        if _repo.returncode == 0 and (_repo.stdout or "").strip() not in ("", "[]"):
            line(SUBJECT, "ok", f"chart {k8s.CHART} resolves in houston's Helm home",
                 check="kubernetes-chart-repo")
        else:
            line(SUBJECT, "warn", f"chart {k8s.CHART} does not resolve in the Helm "
                         f"home houston installs from — `up` adds the repo "
                         f"itself, so this matters only if a create fails "
                         f"naming it", check="kubernetes-chart-repo")
    except Exception:  # noqa: BLE001 - a check must never break the report
        pass
    # HELM'S OWN ANSWER, because houston drives two clients and this
    # check only ever asked one. They resolve their configuration
    # differently -- `helm_env` gives helm houston's HELM_* homes while
    # leaving KUBECONFIG to whoever owns the cluster -- so they can
    # disagree, and the create finds out four minutes in.
    #
    # Measured on this box: `~/.kube/config` carried the server CA and
    # client certificate of a PREVIOUS k3s install. kubectl was happy --
    # `get ns`, `auth whoami` as system:admin, the whole MongoDB phase of
    # a create -- and helm refused every call with `x509: certificate
    # signed by unknown authority`. So `up --runtime kubernetes` built a
    # namespace, a StatefulSet, a PersistentVolume and an initiated
    # replica set, then died at the chart and rolled all of it back. This
    # row is the difference between that and one line before anything runs.
    if pre.helm_reachable:
        line(SUBJECT, "fail", f"helm cannot reach cluster {pre.context!r} although "
                     f"kubectl can — every Kubernetes create will fail at "
                     f"the chart, after MongoDB, and roll back. helm said: "
                     f"{pre.helm_reachable}. A kubeconfig left over from a "
                     f"previous install of the same cluster does this; "
                     f"regenerate it (k3s: `sudo cat "
                     f"/etc/rancher/k3s/k3s.yaml > ~/.kube/config`, kind: "
                     f"`kind export kubeconfig --name <cluster>`)",
             check="kubernetes-helm-reach")
    _report_certmanager_and_endpoints(k8s, line, pre)


def _report_storage_and_ingress(line, needed, pre):
    """The two capabilities a workspace cannot be created without."""
    if "storage" in pre.unreadable:
        # NOT "no default StorageClass". The cluster refused the read, so
        # houston does not know whether a volume would bind -- and saying
        # it would not is a false fact that sends someone to install a
        # provisioner they already have. `up` will refuse with the real
        # permission error; this says so rather than pre-empting it wrongly.
        line(SUBJECT, needed, f"Cluster {pre.context!r} would not let houston read "
                     "its StorageClasses, so whether a workspace's volume "
                     "can bind is unknown — check the credential in your "
                     "kubeconfig has read access", check="kubernetes-storage")
    elif not pre.default_storage_class:
        # The guide's own warning, and the failure is silent: a PVC
        # stays Pending forever and nothing names storage.
        line(SUBJECT, needed, f"Cluster {pre.context!r} has no default "
                     "StorageClass — a workspace's volume would stay "
                     "Pending with no error naming storage", check="kubernetes-storage")
    else:
        line(SUBJECT, "ok", f"Storage: {pre.default_storage_class} (default)",
             check="kubernetes-storage")

    # WHAT THIS CLUSTER PROVIDES, reported the same way on every
    # distribution so the difference between two of them is visible rather
    # than implied. All three are `ok` rows on purpose: a capability is a
    # FACT, and severity belongs to whatever needs it -- an absent ingress
    # controller cannot affect a workspace reached by port-forward, and
    # `k8s.ensure_ingress` is what ADOPTS one or installs it when a workspace asks
    # for a hostname, so an absent controller is not a fault here either.
    # A doctor that warns about a feature you are not using teaches people
    # to ignore its warnings.
    if "ingress" in pre.unreadable:
        line(SUBJECT, "warn", f"Cluster {pre.context!r} would not let houston read "
                     "its IngressClasses — whether a hostname can be "
                     "served from it is unknown", check="kubernetes-ingress")
    elif pre.ingress_classes:
        line(SUBJECT, "ok", "Ingress: " + ", ".join(pre.ingress_classes)
             + " — a hostname can be served from this cluster",
             check="kubernetes-ingress")
    else:
        line(SUBJECT, "ok", "Ingress: none installed — workspaces are reached by "
                   "port-forward, which needs no controller",
             check="kubernetes-ingress")


def _cluster_capabilities(k8s, line, needed, pre):
    """Version skew, storage, ingress, load balancer and metrics -- what the cluster can do."""
    # SKEW, and it is a different question from the version floor above.
    # A floor is a fact about houston; skew is a fact about THIS cluster,
    # and only the second can be true. The static floor is kubectl 1.21
    # while Rocket.Chat's own Launchpad builds clusters at 1.33, so a
    # kubectl eleven minors past the floor still cannot talk to one --
    # and passing a floor is exactly what it would report doing.
    gap = k8s.skew(pre.context)
    if gap and not gap["ok"]:
        cv = ".".join(str(n) for n in gap["client"][:2])
        sv = ".".join(str(n) for n in gap["server"][:2])
        line(SUBJECT, needed, f"kubectl {cv} is outside the supported ±"
                     f"{k8s.KUBECTL_SKEW} window for this cluster's API "
                     f"server ({sv}) — calls do not fail cleanly across "
                     f"that gap, they fail on a field one side does not "
                     f"know, which reads as a bug in whatever was being "
                     f"deployed", check="kubernetes-skew")
    elif gap:
        line(SUBJECT, "ok", f"kubectl matches the API server "
                   f"({'.'.join(str(n) for n in gap['server'][:2])})",
             check="kubernetes-skew")
    _report_storage_and_ingress(line, needed, pre)
    if pre.loadbalancer:
        line(SUBJECT, "ok", f"Load balancer: working — {pre.loadbalancer}",
             check="kubernetes-loadbalancer")
    else:
        # Not "absent": no address means either no controller or nobody
        # asked for one, and those cannot be told apart from outside.
        line(SUBJECT, "ok", "Load balancer: not confirmed — no LoadBalancer Service "
                   "here has an address", check="kubernetes-loadbalancer")
    if pre.metrics:
        line(SUBJECT, "ok", "Metrics: metrics-server answering — `houston stats` "
                   "works here", check="kubernetes-metrics")
    else:
        line(SUBJECT, "ok", "Metrics: no metrics-server — `houston stats` refuses "
                   "and says how to install it", check="kubernetes-metrics")


def _cluster_identity(k8s, line, pre):
    """Which cluster this is, what shape it is, and whose it is."""
    where = (f", {len(pre.namespaces)} workspace namespace(s)"
             if pre.namespaces else "")
    # WHAT it is and what SHAPE it is, on the line that names it. The
    # distribution is a label for exactly this -- so a reader is told "k3s"
    # rather than left to infer it from a ctx.context called `default` -- and
    # the node count is what decides whether a node-local StorageClass can
    # bite.
    # "0 nodes" WAS PRINTED FOR A CLUSTER NOBODY COULD READ, beside a
    # tick, on a single-node cluster that was up. A count we do not have
    # is not a count of zero.
    shape = ", ".join(
        (["node count unknown"] if "nodes" in pre.unreadable else
         [f"{pre.node_count} node" + ("s" if pre.node_count != 1 else "")])
        + ([", ".join(pre.architectures)] if pre.architectures else []))
    where = (f" ({pre.distribution or 'unknown'}, {shape})" if shape
             else f" ({pre.distribution or 'unknown'})") + where
    if pre.provider == k8s.PROVIDER_EXTERNAL:
        # Saying whose cluster it is, before anything is created in it.
        # houston owns the namespaces it labels and never the cluster,
        # so `down` and `prune` will leave this cluster standing.
        line(SUBJECT, "ok", f"Using your cluster {pre.context!r}{where} — houston "
                   "creates namespaces in it and never removes the "
                   "cluster itself", check="kubernetes-cluster")
    else:
        line(SUBJECT, "ok", f"Cluster {k8s.CLUSTER_NAME!r} reachable{where}", check="kubernetes-cluster")


def _report_edge_claim(claim, harmed, installed_edge, line):
    """Who holds the shared edge, and whether this box can still reach it."""
    if installed_edge:
        what = (", ".join(harmed[:3]) + ("\u2026" if len(harmed) > 3 else "")
                if harmed else "every name it is given")
        took = ", ".join(f":{p}" for p in claim.ports if p in (80, 443))
        # WHICH port decides which half is broken, so both are spelled out.
        # ACME on this box validates over whichever challenge is configured,
        # and each one needs a different port back.
        hurts = []
        if 443 in claim.ports:
            hurts += ["serving https", "the tls-alpn challenge"]
        if 80 in claim.ports:
            hurts += ["the http-01 challenge", "the :80 redirect"]
        # Guarded, not assumed. `port_claiming_cluster` only returns a claim
        # that overlaps (80, 443) today, so this list cannot be empty -- but an
        # IndexError here is swallowed by the section's except and the whole
        # Kubernetes report collapses to "could not be determined", which is
        # the failure mode that hides rather than shows.
        broken = (", ".join(hurts[:-1]) + " and " + hurts[-1] if len(hurts) > 1
                  else (hurts[0] if hurts else "the edge's ports"))
        line(SUBJECT, "warn",
             f"cluster {claim.context!r} holds this host's {took} at "
             f"{claim.address} ({claim.service}), so houston's edge cannot "
             f"receive there: {what} answers from the cluster through the host "
             f"\u2014 a 404 and the cluster's own certificate \u2014 while the "
             f"edge itself is fine and bound. This breaks "
             f"{broken}. A box serves HTTPS for one runtime at a "
             f"time: remove the edge on a Kubernetes box, or give the host "
             f"ports back with `kubectl -n kube-system patch svc "
             f"{claim.service.split('/')[-1]} -p "
             f"'{{\"spec\":{{\"type\":\"NodePort\"}}}}'` \u2014 which the "
             f"next k3s install undoes, so make it permanent with `--disable "
             f"traefik --disable servicelb`",
             check="kubernetes-edge-port")


def _report_cluster_to_create(in_use, k8s, k8s_workspaces, line, pre):
    """No cluster yet: say what `up` would build, and what is already on this box."""
    # Ordered BEFORE the not-answering branch, which would otherwise
    # claim a cluster nobody has made yet is broken.
    # NAMES THE BINARY THAT MAKES THE CLAIM TRUE. Reported as confusing
    # by someone who believed kind was not installed: the row promised a
    # cluster would be created and said nothing about what would create
    # it, so there was no way to tell the claim was well-founded. It
    # requires kind (`can_provision`), so saying which kind settles it.
    _kind = pre.tools.get("kind")
    _by = f" by kind {_kind.pretty}" if _kind and _kind.present else ""
    # WARN, NOT FAIL, and this is a deliberate downgrade. A record whose
    # cluster has been removed blocks nothing: the next `up` builds a fresh
    # cluster, and the stale record is a cleanup task rather than a broken
    # machine. Reported as a fail it made `doctor` answer "Not ready — fix
    # the ✗ item(s)" about a box that was completely usable, which is how a
    # verdict stops being read.
    #
    # And it says what to DO. The place to learn about a stale record is the
    # command that removes it, so the row names that command and the
    # workspaces it applies to -- the data went with the cluster either way.
    _stale = ", ".join(sorted(k8s_workspaces)[:3])
    _more = ("…" if len(k8s_workspaces) > 3 else "")
    line(SUBJECT, "warn" if in_use else "ok",
         f"No cluster yet — {k8s.CLUSTER_NAME!r} is created on first use"
         f"{_by}"
         if not in_use else
         f"Cluster {k8s.CLUSTER_NAME!r} is gone, so {len(k8s_workspaces)} "
         f"record(s) point at nothing ({_stale}{_more}). Their data went "
         f"with it; `houston down --name <it> --volumes` clears each "
         f"record, and the next `up` builds a fresh cluster.",
         check="kubernetes-cluster")
    # The box that has BOTH. Saying which one is about to be used is not
    # enough on its own -- someone with a running k3s and no kind cluster
    # needs to be told their cluster was seen and set aside, or the next
    # question is why houston is building a second one.
    other = k8s.active_context()
    if other and other != pre.context and k8s.reachable(other):
        # The remedy USED to be "uninstall kind", which was the only one
        # there was and is a heavy thing to ask of somebody who wants both.
        # `--ctx.context` is now the direct answer, so it leads; uninstalling
        # still works and is no longer the headline.
        line(SUBJECT, "ok", f"Your cluster {other!r} "
                   f"({k8s.distribution(other) or 'unknown'}) is running and "
                   f"will NOT be used by default — houston creates its own "
                   f"while kind is installed. Use it with "
                   f"`--ctx.context {other}`, or make it this box's default "
                   f"with `houston config set kubernetes.context {other}`",
             check="kubernetes-other-clusters")


def _report_owned_clusters(cloud, ekssvc, line, remembered):
    """The cloud clusters this box remembers making, and what each still costs."""
    for owned in remembered:
        left = ekssvc.days_until(str(owned.get("expires") or ""))
        # PAST ITS DATE is a louder answer than "still running", because the
        # sum involved is one somebody stopped thinking about. It is still a
        # warning and never a failure: nothing here deletes, and a report that
        # blocks on somebody's spending decision is not a report.
        when = ("" if left is None else
                f" — {left} day(s) left on its expiry" if left >= 0 else
                f" — {-left} day(s) PAST the expiry it was created with")
        line(SUBJECT, "warn",
             f"houston built the {owned.get('provider', 'cloud')} cluster "
             f"{owned.get('name')!r} in {owned.get('region')} "
             f"(account {owned.get('account')}) on "
             f"{str(owned.get('created_at', ''))[:10]}{when} — it is billing "
             f"until `houston cluster delete {owned.get('name')}` removes it",
             check="kubernetes-cloud-owned")

    # AND WHEN THE RECORD IS EMPTY BUT THE ACCOUNT IS RIGHT HERE. The loop
    # above reads a local pointer, and silence from it means one of two very
    # different things: nothing was ever built, or the pointer is gone. The
    # pointer is deliberately "best effort, never load-bearing", and CLAUDE.md
    # tells anyone writing a script to `export HOUSTON_HOME=$(mktemp -d)` --
    # so following this project's own instructions produces a create whose
    # reminder is discarded. A fresh home, a rebuilt box or a colleague's
    # machine all land in the same place.
    #
    # OBSERVED: a cluster tagged `houston`, ACTIVE, expiring the next day,
    # while `~/.houston/clusters/` did not exist at all -- so `doctor` on that
    # box said nothing about it. `doctor` is the command people run out of
    # habit; `cluster list` is the one that actually asks AWS, and it has to be
    # run deliberately. The whole gap is that nothing routed the first to the
    # second.
    #
    # SAME CHECK ID, because it is the same SUBJECT -- what has houston built
    # that is costing money -- and `CHECKS` is per subject precisely so one
    # check keeps one id whatever it finds. This finds "I cannot tell you from
    # here", which is a third answer alongside "none" and "these".
    #
    # Only when the account is actually reachable. Saying this on a box with no
    # credentials would be noise on every Compose-only machine, and the sweep
    # it points at could not run there anyway.
    if not remembered and cloud.ready:
        line(SUBJECT, "warn",
             "this box has no local record of a cloud cluster, which is not "
             "the same as there being none — the record is best-effort and a "
             "fresh HOUSTON_HOME, a rebuilt box or a create made elsewhere "
             f"all lose it. The account ({cloud.identity.pretty}) is reachable "
             "from here, so ask AWS instead: `houston cluster list` sweeps "
             "every enabled region by tag.",
             check="kubernetes-cloud-owned")


def _report_cloud_clusters(ctx, line, pre):
    """The cloud side: what AWS can be asked, and what this box remembers owning."""
    # AWS, and ONLY when it is somebody's business. A box running Compose and
    # kind must not have its report padded with cloud complaints it will never
    # act on -- the same reasoning as the one-line "Kubernetes not set up"
    # above. Relevant means: a cloud tool is installed, so somebody is setting
    # this up, or the cluster being reported on IS an EKS one, in which case
    # `aws` is not optional at all -- an EKS kubeconfig authenticates by
    # shelling out to it, so without it every kubectl call fails opaquely.
    from houston.services import eks as ekssvc

    # A CLOUD CLUSTER THIS BOX BUILT IS REPORTED WHATEVER ELSE IS TRUE, and
    # deliberately outside the relevance gate below. The gate asks "is AWS
    # somebody's business here" and answers from installed tooling — but a
    # cluster does not stop billing because `aws` was uninstalled afterwards,
    # and that is precisely the box most likely to have forgotten it. Read
    # from the local pointer rather than from AWS, which is why the pointer
    # exists: `doctor` must be able to say this without a credential or a
    # round trip.
    # Started at the top of this function; usually finished by now.
    cloud = ctx.cloud.result() if ctx.cloud is not None else ekssvc.aws.preflight()
    remembered = (ctx.owned.result() if ctx.owned is not None
                  else ekssvc.remembered())
    _report_owned_clusters(cloud, ekssvc, line, remembered)

    on_eks = (pre.distribution or "") == "eks"
    if on_eks or any(t.present for t in cloud.tools.values()):
        if cloud.ready:
            line(SUBJECT, "ok", f"AWS ready — {cloud.identity.pretty}, region "
                       f"{cloud.region}", check="kubernetes-cloud")
        else:
            # `fail` only when a cluster in use NEEDS it. Otherwise this is
            # setup in progress, and a red line for a half-finished optional
            # feature is how a report teaches people to ignore red lines.
            for blocker in cloud.blockers:
                line(SUBJECT, "fail" if on_eks else "warn", f"AWS: {blocker}",
                     check="kubernetes-cloud")


def _report_tool_versions(k8s, k8s_workspaces, line, needed, pre):
    """Which of the Kubernetes tools are here, and which are too old to trust."""
    if pre.missing_tools:
        line(SUBJECT, "fail", f"{len(k8s_workspaces)} Kubernetes workspace(s) exist but "
                     f"{', '.join(pre.missing_tools)} is not installed — they "
                     "cannot be reached or torn down", check="kubernetes-tools")
    for name in pre.outdated_tools:
        got = pre.tools[name]
        floor = ".".join(str(n) for n in k8s.TOOLS[name])
        why_floor = k8s.TOOL_FLOOR_REASON.get(
            name, k8s.DEFAULT_FLOOR_REASON)
        line(SUBJECT, needed, f"{name} {got.pretty} is older than {floor}, "
                     f"{why_floor}", check="kubernetes-tools")
    if pre.tools_ready:
        line(SUBJECT, "ok", "Kubernetes tools present (" + ", ".join(
            f"{t.name} {t.pretty}" for t in pre.tools.values()
            if t.present) + ")", check="kubernetes-tools")


def _report_edge_and_neighbours(k8s, line, pre):
    """The shared edge, the other clusters on this box, and the inotify headroom they need."""
    # OUTSIDE the reachable-cluster block, deliberately. This was inside it, so on a
    # box where houston's own cluster does not exist yet the check never ran -- and
    # that is exactly the box where it fired for real: kind chosen and absent, k3s
    # alongside it holding the ports, the edge installed and its name dark. The
    # conflict has nothing to do with whether houston has a cluster.
    #
    # Detection is `k8s.port_claiming_cluster`, which reports the ports the Service
    # actually asks for. This block used to say ":443" whatever it found, so the
    # HTTP-01 half of the same outage -- a cluster holding :80 while the challenge
    # is `http` -- read as healthy. Both candidate contexts are checked there, for
    # the reason recorded on that function.
    claim = None
    try:
        claim = k8s.port_claiming_cluster(
            contexts=tuple(c for c in (pre.context, k8s.active_context()) if c))
    except Exception:  # noqa: BLE001 - a check must not break the report
        claim = None
    if claim:
        try:
            from houston.services import edge as edgesvc
            installed_edge = edgesvc.installed()
            fd = edgesvc.current() if installed_edge else None
            # The GUI's own name is served by the edge too, and on the box where
            # this was measured it was the ONLY affected name -- so counting
            # workspace routes alone would have said "0 names" about a real outage.
            harmed = (([fd.domain] if fd and fd.domain else [])
                      + list(edgesvc.registered())) if installed_edge else []
        except Exception:  # noqa: BLE001 - a check must not break the report
            installed_edge, harmed = False, []
        _report_edge_claim(claim, harmed, installed_edge, line)

    # "Other" must exclude the one we just said we are USING, or the report
    # describes the same cluster twice and the second mention reads as a
    # different one.
    others = [c for c in pre.other_clusters if f"kind-{c}" != pre.context]
    if others:
        # Named, not warned about. Another cluster on the box is normal and
        # none of houston's business; saying so is how the boundary becomes
        # visible before somebody wonders why `prune` left it alone.
        line(SUBJECT, "ok", f"{len(others)} other kind cluster(s) on this box "
                   f"({', '.join(others)}) — houston never deletes "
                   "a cluster it did not create", check="kubernetes-other-clusters")
    for row in inotify_headroom(len(others) + 1):
        line(SUBJECT, row[0], row[1], check="inotify")


def _report_cluster(ctx, in_use, k8s, k8s_workspaces, line, needed, pre):
    """The cluster row and everything under it: tools, cloud, and what is reachable."""
    if pre.missing_tools and not in_use:
        # One line, not five. Someone running only Compose repros should not
        # have their report padded with an unconfigured feature.
        line(SUBJECT, "ok", f"Kubernetes not set up ({', '.join(pre.missing_tools)} "
                   f"not installed) — Compose workspaces are unaffected", check="kubernetes-tools")
    else:
        _report_tool_versions(k8s, k8s_workspaces, line, needed, pre)

        _report_cloud_clusters(ctx, line, pre)

        if pre.cluster_reachable:
            _cluster_identity(k8s, line, pre)
            _cluster_capabilities(k8s, line, needed, pre)
            _cluster_addons(k8s, line, pre)

        elif pre.probe_failed:
            # NOT "does not exist". `kind` talks to Docker, so this is what a
            # stopped Docker looks like -- and telling someone their cluster is
            # absent would send them to create one that is already there.
            line(SUBJECT, needed, f"Could not tell whether cluster {k8s.CLUSTER_NAME!r} "
                         f"exists ({pre.probe_failed}) — kind needs Docker", check="kubernetes-cluster")
        elif pre.will_create:
            _report_cluster_to_create(in_use, k8s, k8s_workspaces, line, pre)
        elif pre.context == k8s.CONTEXT and pre.cluster_exists:
            # NOT "its API server is not answering", which is what this said and
            # was measured to be false: the cluster was up, `/readyz` said ok and
            # the control plane had been running for minutes. The real state is
            # that THIS HOUSTON_HOME has never used the cluster, so houston's
            # own kubeconfig does not name the ctx.context yet -- and the next `up`
            # exports it and reuses the cluster.
            #
            # The old wording pointed at deleting a healthy cluster that may hold
            # somebody else's workspace, which is the worst advice available here.
            # And it fired by following CLAUDE.md's own instruction to run scripts
            # under `export HOUSTON_HOME=$(mktemp -d)`.
            line(SUBJECT, "ok", f"Cluster {k8s.CLUSTER_NAME!r} exists and this "
                       f"HOUSTON_HOME has not used it yet, so its kubeconfig is "
                       f"not exported here — the next `houston up` exports it "
                       f"and reuses the cluster", check="kubernetes-cluster")
        elif pre.context:
            line(SUBJECT, needed, f"Cluster {pre.context!r} is configured but its API "
                         "server is not answering", check="kubernetes-cluster")
        elif pre.tools_ready:
            # kubectl and helm but no kind and no kubeconfig: usable the moment
            # a cluster is pointed at, and the two ways to get one are named.
            line(SUBJECT, needed, "No Kubernetes cluster configured — install kind so "
                         "houston can create one, or point kubectl at an "
                         "existing cluster (k3s, minikube, Docker Desktop)", check="kubernetes-cluster")


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # --- Kubernetes -------------------------------------------------------
    # Severity depends on whether anything USES Kubernetes. A box with no cluster
    # is perfectly healthy if nobody wants one, and broken if a Kubernetes
    # workspace already exists on it -- the same finding, opposite severity. A
    # doctor that reports FAIL for a feature you are not using teaches people to
    # ignore its failures.
    #
    # kind is OPTIONAL throughout. Creating a cluster needs it; using one does
    # not, and k3s, minikube, Docker Desktop and remote clusters are all ordinary
    # Kubernetes to everything houston does inside a namespace.
    try:
        from houston.services import k8s, topology
        k8s_workspaces = [m.name for m in runner.list_meta()
                          if topology.of_meta(m) == topology.KUBERNETES]
        in_use = bool(k8s_workspaces)
        needed = "fail" if in_use else "warn"
        pre = k8s.preflight(ctx.context or config.default_kube_context())

        _report_cluster(ctx, in_use, k8s, k8s_workspaces, line, needed, pre)

        _report_edge_and_neighbours(k8s, line, pre)
    except Exception:  # noqa: BLE001 - a check must never break the report
        line(SUBJECT, "warn", "Kubernetes status could not be determined")
    return report.rows
