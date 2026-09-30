"""Read-only endpoints about the BOX rather than about any one workspace.

Health, the Kubernetes probe, the doctor report, the create dialog's settings, the
machine's capacity, the preset list and version resolution. They have nothing in common
except that: none of them names a workspace, and none of them changes anything.

`/api/settings` is the load-bearing one. The create dialog's per-runtime costs and its
refusal list come from here — built from the same constants `check_capacity` spends and
the same registry `create_repro` enforces — precisely so the browser is not carrying a
second copy of a rule the service owns. A copy in JS would still be refusing
`--reg-token` long after the service stopped.
"""
from __future__ import annotations

from fastapi import Request

from houston import config
from houston import presets as presets_mod
from houston import runner
from houston.errors import ValidationError
from houston.services import lifecycle as lc
from houston.services import topology
from houston.web.context import AppContext


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name and the suite patches some of them -- but `register` is
#: the only thing anything outside this package may reach for, and a test walks the
#: imports to prove nothing does.
__all__ = ("register",)

def _kube_clusters() -> list[dict]:
    """Clusters this server can offer the create form, with what each one IS.

    Rows rather than bare names, because the form has to say which of them costs
    money -- and deriving that in JavaScript would be a second copy of a rule the
    service already owns. This dialog's own note makes the point about the refusal
    registry: "a copy in JS would still be refusing --reg-token". The same applies to
    "is this cluster billable", and `known_contexts()` is where that is decided.

    Never raises and never distinguishes "none" from "could not ask" TO THE CALLER,
    because the only consumer is a form that renders a list: an empty one falls back
    to "decide for me", which is what an un-set `--context` means anyway. The refusal
    that matters is at the create route, where `contexts()`'s second return value IS
    honoured and an unreadable kubeconfig deliberately does not refuse.
    """
    try:
        from houston.services import cluster as clustersvc
        return clustersvc.known_contexts()["contexts"]
    except Exception:  # noqa: BLE001 - a form that cannot list clusters still renders
        return []


def health(request: Request):
    # Deliberately says nothing about identity any more. `actor` lived here
    # only because there was nowhere else to ask who was signed in; that is
    # `GET /api/session` now, and an endpoint left open for uptime checks
    # should not be reading credentials at all.
    return {"ok": True, "docker": runner.docker_available()}


def kubernetes_status():
    """Which Kubernetes this box has, and what it provides.

    Its own endpoint for exactly the reason `/api/edge` is one: this shells out to
    kubectl several times, and `/api/health` is the cheap unauthenticated call every
    tab makes every four seconds. Read once when the page loads and again on Refresh.

    The same facts `doctor` reports, from the same probe, so the footer and the
    report cannot disagree about which cluster you are on.
    """
    from houston.services import k8s

    try:
        pre = k8s.preflight()
    except Exception:  # noqa: BLE001 - a badge must never be the thing that breaks
        return {"usable": False, "reachable": False}
    # `usable` HERE MEANT tools_ready, AND `Preflight.usable` MEANS tools_ready AND
    # cluster_reachable. A box with the tools and no cluster answered
    # `{"usable": true, "reachable": false}`. app.js reads the pair and is correct
    # today; a second consumer reading `usable` alone would be wrong, and the same
    # word meaning two things across a seam is how that happens. `tools_ready` is
    # published under its own name and `usable` now matches Preflight.
    return {"usable": pre.usable, "tools_ready": pre.tools_ready,
            "reachable": pre.cluster_reachable,
            "context": pre.context, "distribution": pre.distribution,
            "can_provision": pre.can_provision, "nodes": pre.node_count,
            "workspaces": len(pre.namespaces)}


def doctor():
    """The same preflight checks as `houston doctor`.

    The dashboard's docker badge could only say up/down; when it said down,
    every card reported "docker unavailable — actions disabled" and offered no
    diagnosis. This is the click-through.

    MINUS the rows that carry an `elsewhere`: facts the browser already shows
    permanently — the edge chip, the People page, the fields the New workspace
    form offers. A terminal has none of those, so they stay in `houston
    doctor`; here they made a diagnostic mostly a summary of the window around
    it. Only `ok` rows are ever tagged, so nothing that reports a PROBLEM is
    dropped, and the counts still cover every check that ran.
    """
    from houston.services import doctor as doctorsvc
    report = doctorsvc.run_checks()
    report["checks"] = [c for c in report["checks"] if not c.get("elsewhere")]
    return report


def settings(request: Request):
    """Remembered settings the create dialog needs to behave correctly.

    Only whether a Let's Encrypt contact email exists, never the address: the
    form's email field said "leave blank, it is remembered", which is true for
    someone who ran `houston config set acme.email` and false for everyone
    else -- and the GUI has no way to set it. A blank field then produced a job
    that failed on a required value the form had called optional.
    """
    return {"acme_email_remembered": bool(config.load_config().get("acme_email")),
            # So the dialog can offer the privileged fields to exactly the people
            # the server would accept them from, rather than rendering them for
            # everybody and failing the create.
            "may_set_privileged": lc.may_set_privileged_fields(
                getattr(request.state, "actor", "") or ""),
            "privileged_fields": list(lc.PRIVILEGED_CREATE_FIELDS),
            # The clusters this SERVER can see, so the dialog offers names
            # that exist instead of a free-text box where an EKS context has
            # to be typed from memory. Same rule as `runtimes` below: the
            # list comes from the function the create itself validates
            # against, so the form cannot offer one `plan_cluster` would
            # refuse. Two local `kubectl config` reads, and only when the
            # create dialog opens -- this endpoint has no other caller.
            "kube_clusters": _kube_clusters(),
            # The runtime/deployment axes, from the one table that defines them,
            # so the dialog cannot offer a combination the service layer refuses.
            # The same reasoning as `privileged_fields` directly above: two
            # places deciding the same thing is how the form ends up rendering a
            # field the API rejects, which is exactly what happened there.
            "runtimes": [
                {"name": rt, "deployments": list(deps),
                 "default_deployment": deps[0],
                 # What it costs and what it builds, from the same constants
                 # `check_capacity` spends -- a card quoting one number while
                 # the preflight reserves another is a card the refusal
                 # contradicts. Per deployment, because microservices is not
                 # a monolith with a label.
                 "cost": {dep: lc.runtime_cost(rt, dep) for dep in deps},
                 # And what this runtime cannot honour, from the registry the
                 # create path enforces. The list has shrunk twice; a copy
                 # written into the form would still be refusing `--reg-token`.
                 "unsupported": lc.unsupported_fields(rt)}
                for rt, deps in topology.DEPLOYMENTS.items()
            ],
            "default_runtime": topology.DOCKER,
            # What a workspace will publish ON if nobody says otherwise. The
            # dialog needs it to tell a browser on ANOTHER machine the truth:
            # with the default 127.0.0.1 the workspace it is about to create
            # will be reachable from the server and from nowhere else, which is
            # not something a GUI-only user can find out any other way. Not a
            # secret -- `up` prints it, and it is an interface, not a
            # credential.
            "default_bind_host": (config.load_config().get("bind_host")
                                  or config.DEFAULT_BIND_HOST)}


def machine():
    """What the home page leads with: how much room this box has left.

    `/api/machine`, not `/api/capacity` -- "capacity" already means the load
    test that searches for a workspace's breaking point
    (POST /api/repros/{name}/capacity). One word for two unrelated things in
    the same API is how somebody ends up calling the wrong one.

    Cheap on purpose: one read of /proc/meminfo and no docker, because this is
    fetched on every visit, unlike /api/doctor which shells out twice.
    """
    return lc.capacity()


def list_presets():
    return {"presets": [
        {"name": p.name, "description": p.description, "params_help": p.params_help,
         "requires_license": p.requires_license,
         # `notes` were printed by `up` and `info` and shown NOWHERE in the
         # browser. For `oidc` that is not cosmetic: the scenario does not work
         # until `127.0.0.1  keycloak` is in /etc/hosts, and a GUI-only user had
         # no way to learn it. Same for s3_minio in presigned mode.
         "notes": list(p.notes or []),
         "ports": list(config.PRESET_PORTS.get(p.name, ()))}
        for p in presets_mod.list_presets()]}


def resolve_version(version: str, offline: bool = False):
    """Resolve an RC version to its MongoDB pairing WITHOUT launching anything.

    Lets the create dialog show the pairing before the user commits to a
    multi-gigabyte image pull, and pre-empts the trap that otherwise only
    surfaces minutes in as a mongod crash.
    """
    from houston import versions as versions_mod
    try:
        r = versions_mod.resolve(version, offline=offline)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    out = {"rc_version": r.rc_version, "rc_image": r.rc_image, "mongo_tag": r.mongo_tag,
           "mongo_flavor": r.mongo_flavor, "mongo_shell": r.mongo_shell,
           "oplog": r.oplog, "source": r.source, "note": r.note, "kernel": ""}
    # SERVER-121912, before the pull rather than after. The rule itself lives
    # in services/mongo_kernel.py, which is also what create refuses with --
    # this was a second copy of the comparison, and it only warned.
    from houston.services import mongo_kernel
    kv = runner.docker_kernel_version()
    out["kernel"] = kv or ""
    conflict = mongo_kernel.mongo_kernel_conflict(r.mongo_tag, kv)
    if conflict:
        out["warning"] = conflict
    return out


ROUTES = (
    ("get", "/api/health", health),
    ("get", "/api/kubernetes", kubernetes_status),
    ("get", "/api/doctor", doctor),
    ("get", "/api/settings", settings),
    ("get", "/api/machine", machine),
    ("get", "/api/presets", list_presets),
    ("get", "/api/versions/{version}", resolve_version),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
