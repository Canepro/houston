"""Which chart version, and the values houston hands it.

`values_for` is the one place those values are built, and `verify/conformance.py` asks the
REAL published chart whether they are valid -- a key the chart ships commented out is
invisible to `yaml.safe_load` and silently ignored by helm, which surfaces as "the
setting had no effect" and never as an error.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.services.events import Emit
from houston.errors import ValidationError
from houston import config
import json
from houston.services.events import null_emit

from houston.services.k8s import ask
from houston.services.k8s import manifests as kubedocs
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, CHART, HELM_REPO, HELM_REPO_URL, MONGO_OPLOG_URL, MONGO_URL
from houston.services.k8s.operator import REG_TOKEN_KEY

# --- provisioning: the first thing here that writes to the machine ---------------
































def ensure_repo(emit: Emit = null_emit) -> None:
    """Add and refresh the Rocket.Chat chart repo in houston's own Helm home.

    `own=True` UNCONDITIONALLY, and that is correct rather than an oversight -- it has
    been read as a bug twice, so: every helm call that needs this repo reads it through
    `helm_env`, which always points HELM_* at houston's directories whatever cluster is
    targeted. Writer and readers therefore agree by construction.

    The obvious-looking alternative, `own=vocab.is_ours(context)`, would fix the older
    mismatch by writing `rocketchat` into the USER's repositories.yaml -- mutating their
    Helm configuration as a side effect of running a repro tool, which is the one thing
    `owned_env` exists to prevent.

    No context is threaded in because none is needed: `repo add`, `repo update` and
    `search repo` contact no cluster at all, so KUBECONFIG is irrelevant to them.
    """
    kube.run(["helm", "repo", "add", HELM_REPO, HELM_REPO_URL, "--force-update"],
        timeout=APPLY_TIMEOUT, own=True)
    res = kube.run(["helm", "repo", "update", HELM_REPO], timeout=APPLY_TIMEOUT, own=True)
    if res.returncode != 0:
        raise CreateFailedError(
            "could not read the Rocket.Chat chart repository "
            f"({HELM_REPO_URL}): " + ask.why(res))

#: The oldest chart series whose values schema is the one `values_for()` emits.
#:
#: MEASURED against the live index: it holds 96 chart versions, and below 3.0.0 there
#: is exactly ONE -- 0.1.0, appVersion 1.16.0 -- with nothing in between. So the floor
#: rule ("newest chart whose appVersion is at or below the request"), which is correct
#: everywhere else, drops any request below chart 3.0.0's appVersion straight onto a
#: 1.16-era chart. That chart predates `extraEnv`, `microservices.*`, `mongodb.enabled`
#: and the security-context handling -- every values key houston sets -- so it would
#: render something, and not a working workspace.
#:
#: Refusing is better than that, and better than silently succeeding into a pod that
#: never starts, because the tool HAS an answer for these versions: the Docker runtime
#: handles them natively, which is what `bitnamilegacy` and the oplog rule are for.
OLDEST_CHART_SERIES = 3

def _best_chart_at_or_below(entries, rc_version):
    """The newest chart whose app version does not run ahead of Rocket.Chat's."""
    want = tools._version_key(rc_version)
    exact = [e for e in entries if str(e.get("app_version") or "") == rc_version]
    if exact:
        return str(exact[0]["version"])
    at_or_below = [e for e in entries
                   if tools._version_key(str(e.get("app_version") or "0")) <= want]
    # OLDER THAN EVERY CHART. There is no floor left to stand on, and the branch that
    # used to catch this fell back to the NEWEST chart -- the furthest possible thing
    # from what was asked. Measured: RC 1.0.0 resolved to chart 7.0.2, which deploys
    # 8.6.1. A request NEWER than every chart is the opposite case and is NOT here:
    # every chart's appVersion is at or below it, so it takes the branch below and gets
    # the newest, which for a fresh RC release the chart repo has not caught up with is
    # the honest best effort.
    if not at_or_below:
        oldest = min(entries,
                     key=lambda e: tools._version_key(str(e.get("app_version") or "0")))
        raise ValidationError(
            f"the Kubernetes runtime cannot reproduce Rocket.Chat {rc_version}: no "
            f"chart deploys it or anything older — the oldest is "
            f"{oldest.get('version')} (appVersion {oldest.get('app_version')}). Use "
            f"the Docker runtime for this version by leaving `--runtime` off.")
    best = max(at_or_below, key=lambda e: tools._version_key(str(e.get("version"))))
    chosen = str(best["version"])
    # A CHART FROM ANOTHER ERA IS NOT A MATCH, it is the floor rule running out of
    # charts at the old end. See OLDEST_CHART_SERIES for the measurement.
    if tools._version_key(chosen)[0] < OLDEST_CHART_SERIES:
        raise ValidationError(
            f"the Kubernetes runtime cannot reproduce Rocket.Chat {rc_version}: "
            f"the oldest chart that deploys it is {chosen} (appVersion "
            f"{best.get('app_version')}), which predates every values key houston "
            f"sets, so it would install something other than what you asked for. "
            f"Use the Docker runtime for this version — it supports it natively — "
            f"by leaving `--runtime` off.")
    # DELIBERATELY SILENT WHEN THE CHART IS MERELY BEHIND THE APP. That is the normal
    # case -- this function's own docstring says "most Rocket.Chat releases have no
    # chart with a matching appVersion" -- and a line saying so fired on essentially
    # every create, immediately before `chart X for Rocket.Chat Y` said the same thing
    # more clearly. Seen on a real create and it was noise, which is the defect the
    # rest of this log work exists to remove.
    return chosen


def resolve_chart_version(rc_version: str, emit: Emit = null_emit) -> str:
    """Pin a chart version for a Rocket.Chat version.

    Taken from PR #3, whose rule is right and whose reasoning the official guide
    does not give: most Rocket.Chat releases have no chart with a matching
    appVersion, so an exact match cannot be required. Exact match if one exists,
    else the newest chart whose appVersion is at or BELOW the request -- a floor,
    so the chart is never newer than the app it deploys -- else the newest, warned.

    An unreadable index is terminal rather than falling back to an unpinned chart.
    For a tool whose whole job is version-matching, `helm install` without
    `--version` deploys different software after the next chart release, which
    quietly destroys the only property the workspace was created to have.
    """
    # `own=True` for the same reason as `ensure_repo`, which is what populated this
    # index: the chart index lives in houston's Helm home, and reading it touches no
    # cluster.
    res = kube.run(["helm", "search", "repo", CHART, "--versions", "-o", "json"],
              timeout=APPLY_TIMEOUT, own=True)
    if res.returncode != 0:
        raise CreateFailedError("could not read the Rocket.Chat chart index: "
                                + ask.why(res))
    try:
        entries = json.loads(res.stdout or "[]")
    except ValueError as exc:
        raise CreateFailedError(
            "the Rocket.Chat chart index was not valid JSON") from exc
    if not isinstance(entries, list) or not entries:
        raise CreateFailedError(f"no versions found for the chart {CHART!r}")
    return _best_chart_at_or_below(entries, rc_version)

def _apply_optional_values(host, mongo_secret, mongo_url, oplog, oplog_url, values):
    """The parts of the values file that only appear when something asked for them."""
    if mongo_secret:
        # The URL goes in a Secret and its NAME goes in the values, so
        # `helm get values rocketchat` no longer prints the password to anyone who
        # can read the release. The chart reads both keys from it itself.
        values["existingMongodbSecret"] = mongo_secret
    else:
        values["externalMongodbUrl"] = mongo_url or MONGO_URL
        if oplog:
            # Rocket.Chat below 8.x still wants the oplog URL; 8.x deprecates it.
            values["externalMongodbOplogUrl"] = oplog_url or MONGO_OPLOG_URL
    if host:
        # The chart's own `host:` -- the Ingress rule host AND the source of its
        # ROOT_URL. A bare hostname, guarded at the top of this function.
        values["host"] = host
    # THE CHART SETS SOME OF THESE ITSELF, CONDITIONALLY, and a second entry for one
    # env key is not an override -- it is the server-side-apply failure this function
    # already documents for DEPLOY_PLATFORM:
    #
    #   duplicate entries for key [name="OVERWRITE_SETTING_Show_Setup_Wizard"]
    #
    # Chart 7.0.2 emits that key under `{{- if .Values.license }}` and REG_TOKEN under
    # `{{- if and .Values.registrationToken .Release.IsInstall }}`. Nothing sets
    # `license` today, so this is latent rather than broken -- confirmed by rendering
    # the real chart with it, which produced the key twice. Latent is exactly when
    # this is cheap to fix, so the conditional keys are dropped when the value that
    # makes the chart emit them is present.
    for value_key, env_name in _CHART_CONDITIONAL_ENV.items():
        if values.get(value_key):
            values["extraEnv"] = [e for e in values["extraEnv"]
                                  if e.get("name") != env_name]


def _chart_env(admin_password, host, preset_env, reg_token_secret, root_url):
    """The environment the chart passes to Rocket.Chat, registration token included."""
    # THE WORKSPACE HAS TO BE USABLE ON ARRIVAL, which is what these five give and
    # what Kubernetes was missing entirely. `up` printed "Login admin / admin123"
    # for a workspace where that user had never been created and the setup wizard
    # was still waiting -- confidently stated credentials that did not work, which
    # is worse than printing nothing.
    #
    # Same set and same reasoning as compose.py: skip the wizard, auto-provision the
    # first admin.
    #
    # DEPLOY_METHOD and DEPLOY_PLATFORM are NOT here, and were, for one commit. The
    # chart sets them itself -- it knows perfectly well it is helm on Kubernetes --
    # and a second entry for the same key is not an override but a conflict:
    #
    #   Error: INSTALLATION FAILED: server-side apply failed ... .spec.template
    #   .spec.containers[name="rocketchat"].env: duplicate entries for key
    #   [name="DEPLOY_PLATFORM"]
    #
    # So anything the chart already provides must not be repeated here. `extraEnv`
    # is for what the chart does NOT know: houston's fixed admin and the skipped
    # wizard. That is the line to check before adding to this list.
    env: list[dict] = [
        {"name": "OVERWRITE_SETTING_Show_Setup_Wizard", "value": "completed"},
        {"name": "ADMIN_USERNAME", "value": config.ADMIN_USERNAME},
        {"name": "ADMIN_NAME", "value": config.ADMIN_NAME},
        {"name": "ADMIN_EMAIL", "value": config.ADMIN_EMAIL},
        {"name": "ADMIN_PASS", "value": admin_password or config.ADMIN_PASSWORD},
        {"name": "ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS", "value": "true"},
    ]
    # ROOT_URL, WHICH THIS RUNTIME HAS NEVER SET. The chart emits one only from
    # `.Values.host`, and nothing passed that -- so Rocket.Chat ran on its built-in
    # default while every human reached it on an allocated port. ROOT_URL is what
    # absolute links, OAuth callbacks and CORS derive from, so it was wrong for all
    # of them. Compose has always set it; this makes the runtimes agree.
    #
    # Only when there is no `host`: with one, the chart writes ROOT_URL itself and a
    # second entry here would be a duplicate-key apply failure rather than a win.
    if root_url and not host:
        env.append({"name": "ROOT_URL", "value": root_url})
    # A scenario's Rocket.Chat settings are the SHARED half of the Scenario
    # contract: `OVERWRITE_SETTING_LDAP_*` is byte-identical on both runtimes, so it
    # rides extraEnv here exactly as it rides the service environment on Compose.
    # Only the backing service differs, and that is the manifests the caller applies.
    #
    # AFTER the base list, so a preset can override a default rather than being
    # overridden by one -- the same precedence compose.py gives it ("Preset env wins
    # over base defaults").
    env.extend({"name": str(k), "value": str(v)} for k, v in (preset_env or {}).items())
    if reg_token_secret:
        # By REFERENCE, so the token is never a value in this document. The chart
        # renders extraEnv verbatim, so valueFrom survives -- verified against the
        # published chart rather than assumed.
        env.append({"name": "REG_TOKEN",
                    "valueFrom": {"secretKeyRef": {"name": reg_token_secret,
                                                   "key": REG_TOKEN_KEY}}})
    return env


def _validate_root_address(root_url: str, host: str) -> None:
    """Refuse the two URL shapes the chart cannot render safely."""
    # REFUSED, not normalised. A caller that hands a URL where a hostname belongs
    # has a bug, and quietly stripping the scheme would hide it -- the whole point
    # of this guard is that `https://http://...` was shippable once. `:` catches a
    # port, which the chart would concatenate just as happily.
    if host and any(c in host for c in ("/", ":")):
        raise ValidationError(
            f"chart value `host` must be a bare hostname, not {host!r} — the chart "
            f"renders it as `ROOT_URL: https://{{host}}` and as the Ingress rule "
            f"host, so a scheme or a port corrupts both. Pass a full URL as "
            f"`root_url` instead.")
    if host and root_url:
        raise ValidationError(
            "pass `host` or `root_url`, never both: `host` makes the chart emit its "
            "own ROOT_URL and `root_url` puts one in extraEnv, and two entries for "
            "the same variable is a server-side-apply conflict, not an override.")


def _base_chart_values(repo: str, tag: str, microservices: bool,
                       replicas: int, env: list) -> dict:
    """Values shared by every Rocket.Chat chart deployment."""
    return {
        # pullPolicy and the NATS cluster name are the guide's own values.yaml.
        # IfNotPresent also matters here specifically: a repro box re-creates
        # workspaces on the same versions constantly, and Always would re-pull
        # 1.6 GB each time.
        "image": {"repository": repo, "tag": tag, "pullPolicy": "IfNotPresent"},
        # `enabled` FOLLOWS microservices, because NATS is what the microservices
        # talk over and a monolith never opens a connection to it. The chart defaults
        # it on independently of `microservices.enabled`, so `--deployment monolith`
        # ran a 3-pod NATS cluster that nothing used -- three more pods to schedule,
        # to wait for, and to tear down, which is a third of what pushed the default
        # teardown past its budget.
        "nats": {"enabled": bool(microservices),
                 "cluster": {"name": "rocketchat-nats-cluster"}},
        "replicaCount": max(1, int(replicas or 1)),
        "microservices": {"enabled": bool(microservices)},
        "mongodb": {"enabled": False},
        "extraEnv": env,
    }


def values_for(*, rc_version: str, rc_image: str, microservices: bool,
               replicas: int = 1, root_url: str = "", host: str = "",
               oplog: bool = False,
               mongo_url: str = "", oplog_url: str = "",
               mongo_secret: str = "", reg_token_secret: str = "",
               admin_password: str = "", preset_env=None) -> dict:
    """Chart values for one workspace.

    `root_url` and `host` are TWO DIFFERENT SHAPES and only one may be given.
    `host` is a BARE HOSTNAME, because that is what the chart's own values.yaml
    documents (`host: <domain.xyz>`) and what its template does with it:

        - name: ROOT_URL
          value: https://{{ .Values.host }}

    So the chart CONCATENATES. This function used to take a parameter called
    `root_url` and assign it straight to `values["host"]`, which rendered

        ROOT_URL = https://http://localhost:32812

    verified by `helm template` against chart 7.0.2. It never fired only because
    `_create_kubernetes` did not pass it -- and that was its own defect: with
    `.Values.host` unset the chart emits NO ROOT_URL at all, so every Kubernetes
    workspace ran on Rocket.Chat's built-in default while being reached on an
    allocated host port. Both halves are fixed here, and the shape of each value
    is now in its name so the trap cannot be re-entered.

    `root_url` is the full URL houston reaches the workspace on and rides
    `extraEnv`; `host` is for the ingress case, where the chart derives the URL
    itself. Never both: `values_for`'s own comment below records what happens when
    the chart and `extraEnv` name the same variable -- a server-side-apply failure
    with `duplicate entries for key`, not an override.

    MongoDB is ALWAYS external, never the chart's bundled subchart. PR #3's reason
    holds and is worth keeping: the bundled path is Bitnami, which publishes
    amd64-only images so it cannot work on arm64 at all, and chart 7.0.2 declares
    appVersion 8.6.1 while defaulting MongoDB to 6.0.10, which Rocket.Chat 8.6.1
    rejects outright. One external path that works everywhere beats two where one
    is broken on half the hosts.
    """
    _validate_root_address(root_url, host)
    repo, tag = kubedocs.split_image(rc_image, rc_version)
    env = _chart_env(admin_password, host, preset_env, reg_token_secret, root_url)
    values = _base_chart_values(repo, tag, microservices, replicas, env)
    _apply_optional_values(host, mongo_secret, mongo_url, oplog, oplog_url, values)
    return values

#: Values that make the CHART emit an env var houston also puts in `extraEnv`.
#: Keyed by the value, named by the variable, because the collision is one-to-one and
#: the next one to be added will be too. See the end of `values_for`.
_CHART_CONDITIONAL_ENV = {
    "license": "OVERWRITE_SETTING_Show_Setup_Wizard",
    "registrationToken": "REG_TOKEN",
}
