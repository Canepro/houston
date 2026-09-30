"""Starting, stopping and restarting a workspace that already exists.

Tier 4. The state machine is `types.STATE_ACTIONS`; `preconditions.check_state_request`
decides whether the move is allowed, and this module makes it.
"""
from __future__ import annotations


from houston import config, runner
from houston.errors import DockerError, ValidationError
from houston.services import topology
from houston.services.events import Emit, null_emit, warn
from houston.services.lifecycle import naming, ready
from houston.services.lifecycle.types import _INTERACTIVE_LOCK_WAIT

def _clear_default_if(name: str) -> None:
    def mutate(cfg: dict) -> None:
        if cfg.get("default_repro") == name:
            cfg.pop("default_repro", None)

    # Locked read-modify-write: prune() calls this in a loop and the GUI runs it on
    # worker threads, so a plain read/write pair can lose an update.
    config.update_config(mutate)


def _set_state_kubernetes(target: str, action: str,
                          emit: Emit = null_emit) -> None:
    """stop/start/restart by scaling, which is the nearest true thing Kubernetes has.

    Compose's contract is what this has to match, not Kubernetes' vocabulary: `stop`
    gives the memory back and keeps the data, `start` brings the same workspace back
    on the same port. Scaling to 0 does exactly that -- the PersistentVolumeClaim is
    untouched, so this is as far from `down --volumes` as `docker compose stop` is.

    The port-forward is a real difference and is handled rather than ignored: it dies
    with the pod, so `stop` kills it deliberately (leaving it would publish a port
    that answers nothing) and `start` hands back to `ready`, which re-establishes it.
    """
    from houston.services import k8s

    meta = runner.read_meta(target)
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    context = str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    with runner.repro_lock(target, timeout=_INTERACTIVE_LOCK_WAIT):
        if action in ("stop", "restart"):
            k8s.stop_workspace(target, context=context, emit=emit)
            pid = extra.get("port_forward_pid")
            if pid:
                ready._stop_port_forward(int(pid), namespace=k8s.namespace_for(target))
                runner.update_meta(target,
                                   lambda m: m.extra.pop("port_forward_pid", None))
        if action in ("start", "restart"):
            k8s.start_workspace(target, context=context, emit=emit)
            # NO PORT-FORWARD HERE, and that is the tested answer rather than the
            # obvious one. Restoring it looks like the right symmetry -- `stop` killed
            # it, so `start` should put it back -- and it does not work: scaling up
            # from zero takes far longer than `port_forward`'s brief pod wait, so
            # kubectl attaches to a pod that is not ready, binds the socket for a
            # moment and exits. Measured on a live cluster: `start` reported success,
            # a reachability probe passed, the recorded pid was dead seconds later and
            # the URL answered 000 for the next minute. The codebase already knew the
            # shape of this -- "a forward ... stays alive briefly, long enough to be
            # reused and even to serve one request, before it exits".
            #
            # Only `ready` waits for the pod before forwarding, so only `ready` can
            # honestly restore the URL. What was missing was not the forward: it was
            # SAYING so anywhere but the CLI. This is emitted from the service, so the
            # GUI gets the same sentence instead of a bare {"ok": true}.
            warn(emit, f"{target!r} is scaling back up. Its URL is a port-forward that "
                       f"died with the old pod, and a new one can only be attached "
                       f"once the pod is ready — `houston ready --name {target}` "
                       f"waits for it and re-establishes the forward.", phase="boot")


def set_state(name: str, action: str, emit: Emit = null_emit) -> dict:
    """Stop/start/restart a workspace. Returns what happened, for a caller that
    has to decide what to do next.

    `needs_ready` is the one fact a front-end cannot work out for itself: on
    Kubernetes a `start` scales the deployment back up and CANNOT re-establish the
    port-forward that died with the old pod, so the workspace is running and its
    URL is dark until `ready` waits for the pod and attaches a new one. The GUI used
    to infer that from "did this emit anything", which is a proxy for the real
    question and would answer wrongly the moment any other warning was added.
    """
    target = naming.resolve_name(name)
    # Guarded here rather than in each front-end: the CLI's `stop`/`start`/`restart`
    # and the GUI's always-enabled buttons both arrive through this one function, so
    # one guard covers both and cannot drift between them.
    #
    # Looked up by a hashable key: `action` arrives from a JSON body, and a dict or
    # list reached .get() and raised "unhashable type" -- a 500 rather than the
    # "unknown action" this already knows how to say. Validated BEFORE the runtime
    # split so a bad action is rejected the same way on both.
    if not isinstance(action, str):
        raise ValidationError(f"action must be a string (want start|stop|restart), "
                              f"got {type(action).__name__}")
    if action not in ("start", "stop", "restart"):
        raise ValidationError(f"unknown action {action!r} (want start|stop|restart)")
    if topology.of_repro(target) == topology.KUBERNETES:
        _set_state_kubernetes(target, action, emit=emit)
        return {"name": target, "action": action,
                "runtime": topology.KUBERNETES,
                "needs_ready": action in ("start", "restart")}
    fn = {"start": runner.start, "stop": runner.stop, "restart": runner.restart}.get(action)
    if fn is None:
        raise ValidationError(f"unknown action {action!r} (want start|stop|restart)")
    # Locked like every other mutator. Stop/Restart are always-enabled GUI buttons,
    # so they were clickable straight through a create, backup or upgrade running on
    # the same repro -- and app.js's PENDING map only blocks within ONE tab, so a
    # second tab, a second user or the CLI walked right past it. Stopping mid-backup
    # is the nastiest: _Quiesced.__exit__ restarts the services afterwards, so the
    # stack silently comes back up and the "workspace is stopped" warning never fires.
    # A short timeout because this is interactive: waiting 15 minutes on a click is
    # not a better answer than "something else is working on it, try again".
    with runner.repro_lock(target, timeout=_INTERACTIVE_LOCK_WAIT):
        if fn(target) != 0:
            # A `down`ed repro has no containers, so `compose start` can never
            # revive it. Say what actually works instead of the exit code.
            hint = ""
            if action in ("start", "restart") and runner.rc_state(target) == "absent":
                hint = (f" - {target!r} was `down`ed, so it has no containers to "
                        "start; recreate them from its stored metadata instead")
            raise DockerError(f"`docker compose {action}` failed for {target!r}{hint}")
    # Compose keeps its published port across a stop/start, so nothing has to be
    # re-attached and there is nothing further for the caller to do.
    return {"name": target, "action": action, "runtime": topology.DOCKER,
            "needs_ready": False}
