"""The shapes a workspace request and its record take, and the constants they carry.

Tier 0. Imports nothing from `houston.services.lifecycle`, which is what makes it a leaf
the other seventeen modules can all reach.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace


#: How long an INTERACTIVE mutator waits for the repro lock. repro_lock's own
#: default is 900s, which is right for a create or a restore queued behind
#: another -- and wrong for a button: nobody wants a Stop click to hang for
#: fifteen minutes rather than say "something else is working on this".
_INTERACTIVE_LOCK_WAIT = 60.0


#: Context-name shapes that identify a managed cluster without asking anything.
#: `aws eks update-kubeconfig` writes the cluster ARN as the context name and
#: `gcloud container clusters get-credentials` writes `gke_<project>_<zone>_<name>`,
#: so both name their own service. AKS is NOT here and cannot be: `az aks
#: get-credentials` writes the bare cluster name, which is indistinguishable from a
#: kind or k3s context -- so an AKS default is missed by this check rather than
#: guessed at, and a guess that called someone's k3s billable would be the worse
#: error of the two.
_BILLABLE_CONTEXT_PREFIXES = ("arn:aws:eks:", "gke_")


@dataclass
class CreateReq:
    version: str
    preset: str = "default"
    name: str = ""
    port: int = 0
    root_url: str = ""
    bind: str = ""
    rc_image: str = ""
    mongo: str = ""
    reg_token: str = ""
    params: dict = field(default_factory=dict)
    seed: bool = False
    #: "The CALLER will run the seed, not create_repro." The CLI seeds after
    #: `create_repro` returns so it can render the verification table and honour
    #: `--verify-seed`; the GUI lets the service do it. Both must still record the
    #: seed in the write-ahead note, or `ready` cannot finish an interrupted create --
    #: which is what happened when the CLI passed `seed=False` to hide its intent.
    seed_here: bool = False
    seed_profile: str = "small"
    pin: bool = False
    wait: bool = False
    offline: bool = False
    no_pull: bool = False
    fresh: bool = False
    force: bool = False
    monitor: bool = False
    stats: bool = False
    # The three axes (services/topology.py). Empty/0 means "that runtime's
    # default", never "unset but meaningful" -- resolve_axes turns them into
    # canonical values, and writes the deployment back out as a preset + params so
    # the rest of create is unchanged.
    runtime: str = ""
    deployment: str = ""
    replicas: int = 0
    #: WHICH cluster, for `--runtime kubernetes`. Empty means "decide for me" and
    #: keeps `plan_cluster`'s existing four steps; naming one ADOPTS it and never
    #: provisions -- see `k8s.plan_cluster` step 0 for why that asymmetry is the whole
    #: safety property rather than a convenience.
    #:
    #: PRIVILEGED (see PRIVILEGED_CREATE_FIELDS). Choosing the cluster a workspace
    #: lands in is the same class of decision as `rc_image` ("what code runs") and
    #: `bind` ("where it listens"), and on a shared `serve` it can point a colleague's
    #: workspace at a cluster they cannot see.
    context: str = ""
    # Kubernetes only. The operator brings SCRAM auth and owns the MongoDB
    # bootstrap; it is opt-in because its default would replace a path proven on a
    # live cluster with one that is not. See services/k8s.py.
    mongo_operator: bool = False
    # HTTPS. Two ways in, matching the official docs' DOMAIN + LETSENCRYPT_EMAIL:
    #   --domain [+ --email]  a Let's Encrypt certificate for a public hostname
    #   --https               a certificate from houston's own local CA, no domain
    https: bool = False
    domain: str = ""
    acme_email: str = ""
    # Not a flag: `houston config set acme.staging true`. Let's Encrypt allows 5
    # failed validations per hostname per hour, so a way to rehearse has to exist --
    # but it is not part of the everyday two-flag path.
    acme_staging: bool = False
    # Derived by _pick_challenge, never asked for: dns-01 when provider credentials
    # exist, otherwise the inbound TLS-ALPN-01 the official compose uses.
    acme_challenge: str = "tlsalpn"
    acme_dns_provider: str = ""
    # Kubernetes only, and only when a cluster has more than one. An EKS cluster
    # carrying both `alb` and `nginx` had the choice made by whichever the API server
    # listed first, and the two behave differently for ACME http-01 solving. Empty
    # means "the cluster's own default class, else the first by name" -- see
    # `k8s.ingress_classes`.
    ingress_class: str = ""
    # `up --env KEY=VALUE`. Merged over the preset's env; a None value removes a key.
    env: dict = field(default_factory=dict)
    # Who asked for this, when the GUI has named accounts. Namespaces the derived
    # workspace name so two people can run the same version, and is recorded on the
    # workspace so `list` can show who owns what.
    actor: str = ""
    # Set by _resolve_tls: TLS-ALPN is validated by Let's Encrypt CONNECTING here,
    # so --domain has to publish on a public interface. Derived, not asked for --
    # an explicit --bind always wins.
    bind_public: bool = False


#: Presets that hand the BROWSER a hostname, and the `--set` param that carries it.
#: Each default names THIS machine -- `localhost:8081`, `keycloak:8085`, `minio:9000`
#: -- which is right on a laptop and wrong on every shared install, where it names
#: the visitor's own machine instead. The value is not the container network's
#: business; it is whatever the person typing actually uses.
_BROWSER_HOST_PARAM = {"saml": "idp_host", "oidc": "idp_host", "s3_minio": "s3_host"}


#: Binds from which nothing off this machine can reach a published port.
_LOOPBACK_BINDS = ("127.0.0.1", "localhost", "::1", "")


# Preset sidecar links to surface on the dashboard: preset -> [(label, index into
# config.PRESET_PORTS[preset])]. Ports come from config so they never drift.
_PRESET_LINKS = {
    "email": [("Mailpit", 0)],
    "s3_minio": [("MinIO console", 1), ("MinIO API", 0)],
    "saml": [("Keycloak", 0)],
    "oidc": [("Keycloak", 0)],
    "livechat": [("Widget site", 0)],
    "ldap": [("phpLDAPadmin", 0)],
}


# States beyond running/stopped/down that repro_state() can now hand to the UI:
# mid-transition or wedged, rather than plainly up/stopped/gone. This is the
# backend->UI contract for them -- tests/test_core.py asserts the web UI styles
# each one and offers it as a status filter, so adding a state here fails loudly
# until the dashboard handles it (a state it does not know renders unstyled and,
# before this existed, with no lifecycle buttons at all).
TRANSIENT_STATES = ("restarting", "created", "paused", "dead")


#: The services whose absence makes a "running" workspace a lie. Rocket.Chat serves
#: /api/info with no database behind it -- measured: /api/info 200, login 000 after
#: 15s, `ready` exit 0, `list` running, detail health "healthy", and the truth sitting
#: in the same payload's containers array as ("mongodb", "exited"). Every remediation
#: the tool then offered pointed back at `ready`, which reported success, so there was
#: no way out of the loop without reading `docker ps` by hand.
#:
#: DELIBERATELY JUST THE DATABASE. A stopped Mailpit or phpLDAPadmin is a side service
#: a person can live without; treating every preset sidecar as fatal would refuse
#: workspaces that are fine.
ESSENTIAL_SERVICES = ("mongodb",)


#: Actions `set_state` understands. One tuple, so the validator, the error message
#: and the front-ends cannot list three different sets.
STATE_ACTIONS = ("start", "stop", "restart")


#: Who may DESTROY a workspace somebody else owns. `owner` is the default:
#: §3.3's guardrail was "confirms first, naming the owner", and a confirm dialog
#: stops being a guardrail around the twentieth time you click through it for your
#: own workspaces -- by which point the audit log tells you who did it only after
#: the data is gone. `anyone` restores the previous behaviour exactly, for a team
#: that would rather have the confirm.
#:
#: Only DESTRUCTION is gated. Visibility is not, and neither is help: starting,
#: stopping, seeding, load-testing and reading logs on a colleague's workspace all
#: stay open, because covering someone's ticket is the workflow this exists for.
DESTROY_POLICY_KEY = "gui.destroy_policy"


#: Who may set the create fields that decide what CODE runs and where it LISTENS:
#: `rc_image`, `reg_token`, `bind`.
#:
#: DEFAULT: anyone who may create at all, which is member and up. Set it to `admin`
#: to narrow it.
#:
#: The default started as `admin` and was wrong, for a reason worth keeping written
#: down. A member can already create workspaces and tear them down WITH their data.
#: Against that, "you may destroy Maria's customer repro but not choose which
#: interface your own listens on" is not a security boundary -- it is an
#: inconsistent ladder, and every rung it adds is friction for somebody doing the
#: job. A member who needs `--reg-token` to reproduce an Enterprise bug, or `--bind`
#: because the entire point of the box is that teammates reach it, is not escalating
#: anything; they are using the product.
#:
#: What each field actually costs, so narrowing it is an informed choice rather than
#: a reflex:
#:
#:   rc_image   the sharpest. An arbitrary image runs as the user running `serve`.
#:              Anyone with a shell on this box can already do it -- the CLI has no
#:              roles -- so restricting it only binds people who ONLY have the GUI.
#:   reg_token  an EE licence the caller SUPPLIES. Not a secret they extract: the env
#:              tab masks anything key-named like a credential, REG_TOKEN included.
#:   bind       publishes a workspace running fixed admin/admin123. Prefer setting
#:              `bind_host` once for the box; this is the per-workspace override.
#:
#: Narrow it where an account is not the same thing as trust:
#:     houston config set gui.create_policy admin
CREATE_POLICY_KEY = "gui.create_policy"


#: The fields CREATE_POLICY_KEY governs. Named here rather than inline in web/app.py
#: so the check and the message cannot drift apart.
PRIVILEGED_CREATE_FIELDS = ("rc_image", "reg_token", "bind", "context")


#: Distributions where a workspace costs money for as long as it exists, and so where
#: reaching it only by port-forward is a waste rather than a choice. Named here rather
#: than reusing `cluster.BILLABLE` because that one prices a cluster and this one warns
#: about a workspace -- and a services module importing another for a tuple of three
#: strings is a dependency bought at a poor price.
_BILLABLE_DISTRIBUTIONS = ("eks", "gke", "aks")


#: What `up` accepts on Compose and cannot honour on Kubernetes, with the reason.
#: Each of these was ACCEPTED and silently dropped: the create succeeded, said
#: nothing, and produced a workspace that was not what was asked for. `--preset ldap`
#: is the clearest -- the Kubernetes path's only `presets.load` is a hardcoded
#: "default", so the preset name was written into repro.json and nothing else
#: happened. `houston list` then showed "ldap" for a workspace with no LDAP in it.
#:
#: This is the failure mode of the whole runtime split, and it has now produced
#: `--seed`, `--https`, `mongo_flavor`, `mongo_shell` and these. A refusal that names
#: the missing thing is worth more than a create that quietly does less.
_KUBERNETES_UNSUPPORTED: tuple[tuple[str, str], ...] = (
    # `https`, not `tls`. The first cut of this guard read `getattr(req, "tls", "")`
    # -- a field CreateReq does not have -- so it returned "" every time and the
    # refusal never fired once. It was shipped, described in a commit message, and
    # was dead code: `--https` went on being silently dropped exactly as before. A
    # guard keyed on a name nobody checks is worse than no guard, because the
    # docstring then says the case is handled. Hence the loop reads real fields and
    # the test drives it through CreateReq rather than a hand-made object.
    # The reason, stated as what houston has not built rather than as what your
    # cluster lacks. The first version read "HTTPS needs an ingress controller and
    # cert-manager" -- and told a k3s user their cluster was missing both when it
    # ships Traefik as the DEFAULT ingress class with a LoadBalancer already on :443.
    # Verified by hand on k3s: an Ingress with a TLS secret minted from houston's own
    # local CA served Rocket.Chat over https with `ssl_verify_result: 0`, no
    # cert-manager anywhere. So the blocker is this side of the fence, and naming
    # someone else's cluster for it sends them to install something they do not need.
    # `https` IS NO LONGER HERE. The chart's own Ingress template builds the Ingress,
    # cert-manager issues from a `ca` ClusterIssuer backed by houston's CA, and the
    # edge passes the name through by SNI instead of terminating it. What replaced the
    # blanket refusal is a set of REFUSALS ABOUT THIS CLUSTER, in
    # `_kubernetes_tls_plan`: no ingress class, no cert-manager, no reachable :443
    # Service, a cluster that is not on this machine. Each names one missing thing and
    # what to do about it, which a runtime-wide "not supported" could not.
    #
    # `--domain` stays, and its reason is now the true one. It used to say "a hostname
    # needs the Ingress that --https needs" -- which stopped being true the moment
    # --https built that Ingress. What is actually missing is the ACME ClusterIssuer;
    # the ingress half is done and proven, including a real Let's Encrypt certificate
    # issued from inside a cluster by hand.
    # `domain` HAS ALSO LEFT, and for the same reason `https` did: what was missing
    # was an ACME ClusterIssuer, and that is now one `IssuerSpec` away from the `ca`
    # one -- the guide's own values.yaml with the issuer name swapped. What refuses
    # instead is `_kubernetes_tls_plan`, per cluster: no ingress class, no
    # cert-manager, no reachable :443 Service. The contact-email requirement is
    # `_resolve_tls`'s, shared with Compose.
    ("fresh", "--fresh means DELETE this workspace's data, and the Kubernetes path "
              "keeps the PersistentVolumeClaim — use `houston down --name <n> "
              "--volumes` first, which does delete it"),
)


@dataclass
class _KubeTls:
    """What `--https` needs from the cluster, once every refusal has passed.

    Built before the write-ahead record, from reads only, so a refusal leaves nothing
    behind -- the same discipline `plan_cluster` and `assert_namespace_available`
    already follow on this path.
    """
    host: str
    ingress_class: str
    endpoint: "object"
    #: The cluster this workspace lives in, so the route step can ask whether the edge
    #: needs to join its Docker network.
    context: str = ""
    #: Which ClusterIssuer this workspace's Ingress will name. `--https` and `--domain`
    #: differ in this one field and nothing else, which is the guide's own values.yaml
    #: with the issuer swapped.
    issuer: "object" = None
    #: Whether the CLUSTER is already receiving on this host's :443. When it is, the
    #: name works through the cluster with no edge at all; when it is not, the edge
    #: has to own :443 and pass through. Measured rather than assumed, because both
    #: are normal and they need different things.
    cluster_owns_443: bool = False


#: How long the proof below waits for the route to be LIVE, not merely written.
#: Found by running it: the check fired on a chain that was completely correct and
#: reported "answered with a proxy's own default certificate", because a route file
#: appearing and Traefik's file provider having reloaded it are a second apart and
#: `tls.verify` ran in between. Polling is what `cli._report_gui_tls` already does
#: about ACME for exactly the same reason -- a single probe reports "not yet" for
#: every healthy create and teaches people to ignore the line that matters.
PUBLISH_PROOF_TRIES = 8


PUBLISH_PROOF_PAUSE = 1.5


#: How many consecutive ready-but-not-Rocket.Chat rounds before the port is called
#: foreign. Each round costs a `workspace_ready` probe plus a socket check, so this is
#: seconds of grace for a pod that has just passed its probe -- not a retry budget.
tuning = SimpleNamespace(FOREIGN_PORT_STRIKES=4)
