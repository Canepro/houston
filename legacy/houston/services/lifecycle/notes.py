"""The prose a workspace carries: what it is, how to reach it, what to do next.

Tier 2. Every note is built here and rendered by whoever asked -- the CLI prints them,
the GUI puts them in a panel -- so nothing in this module may reach for `ui`.

`note_group` is the one constructor; a group with no rows is dropped by
`note_groups_of`, so a builder can return an empty group rather than branching at
every call site.
"""
from __future__ import annotations

from houston import config, presets, runner
from houston.services import topology

# --- a workspace's notes, as groups ------------------------------------------
#
# A note used to be a string, and the whole set a flat list. That was readable in a
# terminal and became a dump in a browser: eleven bullets in a row, half of them
# repeating metadata the panel already states above them, with the commands you
# actually have to paste buried in the middle as prose.
#
# So the GROUPS are the source and the flat list is DERIVED from them. One
# definition, two renderings: the CLI keeps printing strings and cannot drift from
# what the browser shows, older workspaces whose records hold only the flat list
# still render the old way, and nothing needs a heuristic to work out where one
# thought ends and the next begins -- which is what the browser was doing, and it
# got it wrong twice.
#
# Three kinds of content, because that is what is actually in there:
#   rows      -- facts. Key and value, rendered as a table, never as a sentence.
#   body      -- the thing a reader needs to KNOW. Prose, and only prose.
#   commands  -- the thing a reader has to PASTE. Its own block, with a copy button.
def note_group(title: str, *, rows: list | None = None, body: list | None = None,
               commands: list | None = None, kind: str = "") -> dict:
    return {"title": title, "kind": kind,
            "rows": [list(r) for r in (rows or [])],
            "body": list(body or []), "commands": list(commands or [])}


def flatten_notes(groups: list[dict]) -> list[str]:
    """The groups as the flat string list every existing consumer expects.

    Indentation is the contract the flat form already had and the CLI and the browser
    both parse: a four-space line is something to paste. `key: value` rows become
    that same shape so a terminal reader sees a list rather than a table it has no
    way to draw.
    """
    out: list[str] = []
    for group in groups:
        rows = group.get("rows") or []
        if rows:
            width = max(len(str(k)) for k, _ in rows)
            out.append(f"{group['title']}:")
            out.extend(f"    {str(k).ljust(width)}  {v}" for k, v in rows)
        elif group.get("title"):
            out.append(f"{group['title']}:")
        out.extend(group.get("body") or [])
        out.extend(f"    {c}" for c in (group.get("commands") or []))
    return out


def local_url_note(meta: runner.Metadata, scenario: list[dict]) -> list[dict]:
    """Correct `localhost` in a preset's own browser URLs, when it is wrong.

    `ldap` prints phpLDAPadmin, `s3_minio` its console, `email` Mailpit's inbox,
    `livechat` a demo page -- all browser URLs, all written when the browser was
    assumed to be on the docker host. On a workspace bound wide or given a public URL
    it is not, and `localhost` then names the reader's own machine: the same mistake
    that made the saml and oidc buttons fail silently, in prose instead of a setting.

    Said here rather than fixed in four presets because the right host is a fact about
    the RECORD -- the bind host and the advertised URL -- which a preset builder is
    never given.

    KEYED ON THE NOTES THEMSELVES, which the first version got wrong: it fired
    whenever a preset had side-service ports, so a `saml` workspace whose `idp_host`
    had already put the real host in every line was told "the URLs above say
    localhost". They did not. A correction that describes text the reader is not
    looking at is worse than no correction.
    """
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    body = [line for g in scenario for line in (g.get("body") or [])]
    if not any("localhost" in line for line in body):
        return []
    ports = [p for p in (extra.get("sidecar_ports") or []) if isinstance(p, int)]
    bind_host = str(extra.get("bind_host") or "")
    advertised = str(extra.get("advertised_url") or "")
    if not ports or not (advertised or bind_host not in ("", "127.0.0.1", "localhost")):
        return []
    from urllib.parse import urlsplit
    host = (urlsplit(advertised).hostname if advertised else "") or "<this-box>"
    return [note_group("Reaching this preset's own pages", body=[
        f"The URLs above say `localhost`, which names whichever machine the browser "
        f"is on. From anywhere but this box, use {host} instead: "
        f"{', '.join(f'http://{host}:{p}' for p in sorted(ports)[:4])}.",
        f"Those ports are published on {bind_host or '127.0.0.1'}, so they are "
        f"reachable only as far as that bind allows."])]


# --- the groups, DERIVED from the record --------------------------------------
#
# Derived on every read, not remembered from the create. They used to be built once
# and frozen into `repro.json`, and that is a bug with a name in this file already:
# the "What works here" note told people `backup` had no Kubernetes path for three
# releases after it grew one, and the fix only reached workspaces created after it --
# every existing record kept repeating the old sentence, because the record WAS the
# source. A workspace's notes are a pure function of what the record already holds
# (namespace, context, release, bind host, which preset), so they are recomputed on
# every read and the copy in the record is only ever a record.
def scenario_group(meta: runner.Metadata) -> list[dict]:
    """The preset's own prose as the leading group. Empty for a plain workspace."""
    name = (meta.preset or "").strip()
    if not name or name == "default":
        return []
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    params = dict(extra.get("params") or {})
    try:
        # The SAME resolution the create used, per runtime: a scenario yields native
        # manifests on Kubernetes and a compose service on Docker, and its notes
        # follow the shape it was built in. Resolving it the other way would print
        # instructions for a workspace nobody has.
        if topology.of_meta(meta) == topology.KUBERNETES:
            pre = presets.resolve(name, topology.KUBERNETES, params)
        else:
            pre = presets.load(name, params)
    except Exception:  # noqa: BLE001 - a preset file removed after the create
        # This runs on a READ path (`info`, the GUI panel). A workspace whose preset
        # is no longer loadable still has to be able to describe itself rather than
        # answer 500, so it loses its scenario prose and keeps everything else.
        return []
    notes = list(getattr(pre, "notes", None) or [])
    if not notes:
        return []
    # kind="scenario", not a title the panel has to recognise by its prefix. The
    # panel feeds this group BACK into the scenario card instead of giving it a card
    # of its own: that card already absorbs a place note into the link row naming the
    # same url, and already tells a hosts-file setup step from a credential that
    # merely looks like one. A plain group card loses both.
    return [note_group(f"Scenario · {pre.name}", kind="scenario", body=notes)]


def _kubernetes_https_group(meta: runner.Metadata, extra: dict,
                            ns: str) -> list[dict]:
    """The HTTPS card for a Kubernetes workspace: where TLS actually terminates.

    The one thing genuinely different from Compose, and the thing a support case needs
    told. On Compose the edge holds the certificate as a file; here it holds nothing
    for this name -- it matches the SNI and forwards raw TCP, and the certificate is a
    `kubernetes.io/tls` Secret that cert-manager filled from an annotation on the
    chart's own Ingress. So the commands that answer "why is my certificate wrong" are
    `kubectl describe certificate`, not `houston edge logs`.
    """
    from houston import tls as tlsmod
    from houston.services import k8s

    local = str(extra.get("tls") or "") != tlsmod.MODE_ACME
    endpoint = str(extra.get("ingress_endpoint") or "")
    issuer = k8s.CA_ISSUER if local else k8s.ACME_ISSUER
    body = [
        f"{meta.public_url} is served by the chart's own Ingress in {ns}. TLS "
        f"terminates IN THE CLUSTER, from the Secret {k8s.tls_secret_for(meta.name)} "
        f"that cert-manager issued -- so the failure modes a customer hits (a wrong "
        f"secretName, an expired Certificate, an annotation naming a missing issuer) "
        f"are the real ones here.",
    ]
    if endpoint:
        body.append(
            f"The edge does not decrypt this name: it matches the SNI and forwards "
            f"raw TCP to {endpoint}. Nothing about the certificate is the edge's, and "
            f"`houston edge logs` will not mention it.")
    body.append(
        "A locally-issued certificate: run `houston trust-ca` once and the browser "
        "accepts it, on every workspace on this box."
        if local else
        "A publicly trusted certificate from Let's Encrypt, obtained by cert-manager "
        "over the http-01 challenge. Renewal is cert-manager's, not the edge's.")
    return [note_group("HTTPS", body=body, commands=[
        f"kubectl -n {ns} describe certificate {k8s.tls_secret_for(meta.name)}",
        f"kubectl describe clusterissuer {issuer}",
        f"houston tls-status --name {meta.name}",
    ])]


def _shared_mongo_notes():
    """What to say about a MongoDB this workspace did not create and must not delete."""
    # There is no "reachable at <url>" note any more. The summary panel prints the
    # URL immediately above these notes, the GUI panel's identity line carries it and
    # its links table lists it -- so the note was the fourth copy of one string on one
    # screen, and the browser had to de-duplicate it against the link row to avoid
    # showing it twice. What is NOT said anywhere else is what a non-loopback bind
    # means, and that is the only case this group appears in at all.
    # THE URL IS ONLY PUBLISHED WHILE THE FORWARD LIVES, and nothing said so once it
    # had stopped. A port-forward dies with its pod, so this is ordinary rather than
    # exceptional -- a `restart`, a rescheduled pod, a reboot -- and `list` then showed
    # `running` beside a URL that refused connections. "running" is not wrong about the
    # pods, which is exactly why the reader has nothing to go on: the state is right,
    # the URL is dead, and the repair was documented nowhere.
    #
    # Derived on every read rather than recorded, like every other group here, so it
    # disappears the moment the forward is back. Worded to cover a stopped workspace
    # too, because `_summary` is a read that does not know the state and a note that is
    # only right for one of the two would be worse than one that names both verbs.
    # ONLY WHERE A PID WAS RECORDED. `forward_alive(None)` is False, and reading that
    # as "no forward is running" would be the same mistake this release spent itself
    # removing: a record written before houston tracked the pid, or by a path that
    # never had one, tells us nothing about what is listening. No pid is "I cannot
    # say", and the note claims a fact, so it stays quiet.


def _mongo_group_and_shared_notes(extra, k8s, meta, ns):
    """The MongoDB group itself, and the notes about a database this workspace does not own."""
    # What is IN the namespace versus what is shared by the cluster, stated rather
    # than left to be discovered. The guide installs the MongoDB operator into the
    # Rocket.Chat namespace because it assumes one Rocket.Chat per cluster; houston
    # runs several, its CRDs are cluster-scoped, and a second per-namespace install
    # collides on them. So the deviation is deliberate and has to be visible here --
    # otherwise the first person to run the guide's `kubectl -n <ns> get pods` finds
    # no operator and reasonably concludes it was never installed.
    if extra.get("mongo_managed_by") == "operator":
        mongo_group = note_group("MongoDB", rows=[
            ("Version", meta.mongo_tag),
            ("Image", str(extra.get("mongo_image") or "")),
            ("Managed by", "the official operator"),
            ("Authentication", "SCRAM"),
        ])
        shared = [note_group("The MongoDB operator is shared", body=[
            f"One install in {k8s.OPERATOR_NAMESPACE} watches every namespace, "
            f"rather than one per workspace as the official guide shows. Its CRDs "
            f"are cluster-scoped, so a second per-workspace install would collide "
            f"on them. Nothing of it lives in {ns} except the database, its Secrets "
            f"and its ServiceAccount."],
            commands=[
                f"kubectl -n {k8s.OPERATOR_NAMESPACE} get pods",
                f"kubectl -n {ns} get mongodbcommunity",
            ])]
    else:
        mongo_group = note_group("MongoDB", rows=[
            ("Version", meta.mongo_tag),
            ("Image", str(extra.get("mongo_image") or "")),
            ("Managed by", "a plain StatefulSet"),
            ("Authentication", "none"),
        ], body=[
            f"This path is houston's own: the official guide documents only the "
            f"operator, which needs MongoDB "
            f"{'.'.join(str(n) for n in k8s.OPERATOR_MIN_MONGO)}+. Add "
            f"`--mongo-operator` for the documented path, with authentication."])
        shared = []
    _shared_mongo_notes()
    return mongo_group, shared


def _kubernetes_mongo_group(bind_host, extra, k8s, meta, ns):
    """Where MongoDB came from, which decides what a reader can do about it: the operator's CRD, a StatefulSet houston made, or a shared one somebody else owns."""
    # The port-forward carries the bind host: a workspace created with
    # `--bind 0.0.0.0` needs `--address 0.0.0.0` to come back the same way.
    addr = ("" if bind_host in ("", "127.0.0.1", "localhost")
            else f"--address {bind_host} ")
    mongo_group, shared = _mongo_group_and_shared_notes(extra, k8s, meta, ns)
    return addr, mongo_group, shared


def _forward_and_reach_notes(addr, bind_host, extra, k8s, meta, ns, port, root):
    """The two notes about REACHING this workspace rather than about what it is: a port-forward that has died, and an address other machines can use."""
    forward = []
    recorded_pid = extra.get("port_forward_pid")
    if ns and recorded_pid and not k8s.forward_alive(recorded_pid, namespace=ns,
                                                    host_port=port):
        forward = [note_group("The URL is not published right now", body=[
            f"No port-forward is running for this workspace, so {root} will not "
            f"answer -- a forward dies with its pod, and houston does not keep one "
            f"alive in the background. This says nothing about Rocket.Chat itself; "
            f"the pods may be perfectly healthy."],
            commands=[f"houston ready --name {meta.name}",
                      f"houston start --name {meta.name}   # if it is stopped"])]
    reach = []
    if addr:
        reach = [note_group("Reachable from other machines", body=[
            f"This workspace publishes on {bind_host}, so it answers at "
            f"http://<this-box>:{port} from anything that can route here -- and it "
            f"runs {config.ADMIN_USERNAME}/{meta.admin_pass}. Keep it off "
            f"untrusted networks."])]
    # GROUPS, not a flat list -- see `note_group` for why. The facts that used to be
    # sentences ("microservices on kind-x - about 9 pods, namespace houston-y") are
    # rows now: that one was three facts welded into prose, and it is what the
    # browser kept gluing to the note after it.
    return forward, reach


def _look_at_what_is_inside(ns: str, release: str) -> dict:
    """Step 3: the read-only commands, which are the ones a support case runs."""
    return note_group("3 · Look at what is inside", body=[
            "What is running, what Rocket.Chat is saying, and the values the release "
            "was installed with:"],
            commands=[
                f"kubectl -n {ns} get pods",
                f"kubectl -n {ns} logs -l app.kubernetes.io/name=rocketchat -f",
                f"helm -n {ns} get values {release}",
            ])


def _open_the_way_in(ns: str, release: str, root: str, port: int,
                     addr: str) -> dict:
    """Step 2: the port-forward, which is tied to a pod and dies with it."""
    return note_group("2 · Open the way in", body=[
            f"Rocket.Chat is reached through a port-forward, which is tied to its pod "
            f"and dies with it. This is the one houston started, so run it again if "
            f"{root} stops answering:"],
            commands=[f"kubectl -n {ns} port-forward {addr}"
                      f"deployment/{release}-rocketchat {port}:3000"])


def _how_to_work_with_it(meta, extra: dict, *, ns: str, context: str,
                         release: str, root: str, port: int, addr: str,
                         shared: list) -> list:
    """The three numbered steps a support engineer follows on this runtime.

    Different enough from Compose's that one set of words would serve neither: on
    Compose the way in is a published port; here it is a port-forward that dies
    with its pod, and the kubeconfig has to be pointed somewhere first.
    """
    from houston.services import k8s

    return [
        # THE ORDER IS THE SEQUENCE somebody has to perform, and it was wrong: the
        # port-forward came first, so the first command anyone pasted ran against
        # whatever cluster their own kubectl happened to be pointed at -- or at
        # nothing. The export has to come before every other line here, and the
        # port-forward before anything that reaches Rocket.Chat itself, so the three
        # groups now read top to bottom as: point your tools here, open the way in,
        # then look at what is inside.
        # WHICH kubeconfig, and it is not the same answer on both clusters. houston
        # keeps its own only for the cluster it CREATED: every call is
        # `own=is_ours(context)`, so on a cluster houston adopted it uses the config
        # you already set up and writes nothing of its own. The note said "export
        # KUBECONFIG=<houston's own>" unconditionally -- wrong three ways on an
        # adopted cluster: houston created no cluster, that file does not describe
        # yours, and your kubectl was already pointed at the right one. Following it
        # broke the shell it was pasted into.
        (note_group("1 · Point kubectl and helm at this cluster", body=[
            "houston keeps its own kubeconfig so creating a cluster cannot move the "
            "context you were using. A bare `kubectl` will not see this workspace "
            "until it is pointed here, and every command below assumes it:"],
            commands=[f"export KUBECONFIG={k8s.owned_kubeconfig()}"])
         if k8s.is_ours(context) else
         note_group("1 · Your kubectl already reaches this workspace", body=[
             f"This workspace lives in a cluster you supplied, so there is nothing to "
             f"export -- houston used the kubeconfig you already have and wrote none "
             f"of its own. Every command below runs against context {context!r}; add "
             f"`--context {context}` to any of them if you work in more than one."],
             commands=[f"kubectl config current-context   # expect {context}"])),
        _open_the_way_in(ns, release, root, port, addr),
        # HTTPS, WHICH THIS RUNTIME'S NOTES SAID NOTHING ABOUT. `compose_note_groups`
        # has an HTTPS card and this function had none, so a Kubernetes workspace with
        # a name showed the port-forward and never mentioned it.
        #
        # And it must NOT reuse the Compose wording. That card says "served by the
        # edge … the edge holds :443 for the whole box" -- true there and false here:
        # the edge does not decrypt this name, the certificate is a Secret in the
        # workspace's own namespace, and the thing that issued it is cert-manager. A
        # card that named the wrong terminator would send someone to `edge logs` for a
        # certificate the edge never saw.
        *(_kubernetes_https_group(meta, extra, ns) if meta.public_url else []),
        _look_at_what_is_inside(ns, release),
        # After the three steps, not before them: it carries two `kubectl` lines, and
        # nothing that needs the kubeconfig may appear above the export that sets it.
        *shared,
    ]


def kubernetes_note_groups(meta: runner.Metadata) -> list[dict]:
    """What a Kubernetes workspace is and how to reach it, from its record."""
    from houston.services import k8s

    extra = meta.extra if isinstance(meta.extra, dict) else {}
    ns = str(extra.get("namespace") or meta.project or "")
    release = str(extra.get("release") or "rocketchat")
    context = str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    micro = topology.axes_of_meta(meta).get("deployment", "") == topology.MICROSERVICES
    pods = 9 if micro else 5
    bind_host = str(extra.get("bind_host") or "")
    port = meta.host_port or 3000
    root = meta.root_url or f"http://localhost:{port}"
    addr, mongo_group, shared = _kubernetes_mongo_group(bind_host, extra, k8s, meta, ns)
    forward, reach = _forward_and_reach_notes(addr, bind_host, extra, k8s, meta, ns, port, root)
    return [
        note_group("Kubernetes", rows=[
            ("Cluster", context),
            ("Namespace", ns),
            ("Arrangement", "microservices" if micro else "monolith"),
            ("Pods", f"about {pods}"),
        ]),
        mongo_group,
        *forward,
        *reach,
        *_how_to_work_with_it(meta, extra, ns=ns, context=context,
                              release=release, root=root, port=port,
                              addr=addr, shared=shared),
        note_group("Monitoring", body=[
            f"Prometheus and Grafana are shared by the cluster, not installed per "
            f"workspace: this puts one stack in {k8s.OPERATOR_NAMESPACE}, and `--off` "
            f"leaves it up while any other workspace still wants it."],
            commands=[f"houston monitor --name {meta.name}"]),
        # This used to say "logs, stats and backup have no Kubernetes path yet". Two
        # of the three were right and backup was not: it has run on this runtime
        # since it learned to exec through `kubectl` instead of compose, and an audit
        # found the note still telling users otherwise. A workspace's own notes are
        # where someone checks what they can do with it, so a stale one costs them a
        # capability they already have -- which is also why this is derived and not
        # read back out of a record written months ago.
        note_group("What works here", body=[
            "`logs`, `stats`, `env`, `upgrade`, `backup`, `restore`, `seed`, "
            "`monitor`, `api`, `pat` and `token` all work on this runtime. `stats` "
            "needs metrics-server in the cluster and says so if it is missing; "
            "`env --set` refuses and hands over the `helm upgrade` that changes a "
            "value."]),
    ]


def compose_note_groups(meta: runner.Metadata) -> list[dict]:
    """The add-ons a Compose workspace gained, each as its own group.

    Same three sources the create appended to the flat list -- the scenario (above),
    the edge, the monitoring stack -- so this changes their shape and not one word of
    their content.
    """
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    groups: list[dict] = []
    if extra.get("edge") and meta.public_url:
        groups.append(note_group("HTTPS", body=[
            f"served by the edge at {meta.public_url}",
            "the edge holds :443 for the whole box; this workspace publishes none"]))
    if extra.get("monitoring"):
        from houston import monitoring
        groups.append(note_group("Monitoring", body=monitoring.notes()))
    return groups


def note_groups_of(meta: runner.Metadata) -> list[dict]:
    """Every group this workspace has, scenario first. The one entry point."""
    scenario = scenario_group(meta)
    if topology.of_meta(meta) == topology.KUBERNETES:
        # Not corrected here: a Kubernetes workspace is reached through a port-forward
        # the reader runs themselves, so `localhost` is genuinely their localhost.
        return scenario + kubernetes_note_groups(meta)
    return scenario + compose_note_groups(meta) + local_url_note(meta, scenario)
