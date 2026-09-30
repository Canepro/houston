"""Waiting for a workspace to actually serve, and the last steps once it does.

Tier 3. `wait_serving` polls the HTTP surface; the Kubernetes branch also has to keep a
port-forward alive while it waits, which is why `_wait_serving_kubernetes` is separate
rather than a flag.
"""
from __future__ import annotations

import os
import signal
import time

from houston import config, rcapi, runner
from houston.errors import (ConflictError, CreateFailedError, NotReadyError,
                            ReproError)
from houston.services import diagnose, postready, topology
from houston.services import edge as edgesvc
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle import admin, inspect, seeding
from houston.services.lifecycle.types import ESSENTIAL_SERVICES, tuning

def _say_ready(emit: Emit, final: bool) -> None:
    """The workspace is serving. Whether that is the END is the caller's to say."""
    if final:
        info(emit, "ready", phase="done", pct=100.0)
    else:
        # NO PERCENTAGE, deliberately. `wait_serving` has already emitted 100 by the
        # time this runs, so naming any number here sends the bar BACKWARDS -- seen on
        # a real create as `[100%] ... is serving at`, then `[85%] the workspace is
        # up`, then `[100%]` again. `pct` is optional precisely so a step that is not a
        # position on the bar can decline to move it.
        info(emit, "the workspace is up", phase="wait")


def _readiness_failure(meta: runner.Metadata, seen: dict, *, prefix: str = "",
                       known: str = "") -> NotReadyError:
    """The one place a readiness failure is worded.

    `known` is a diagnosis from `diagnose`, which is preferred over anything guessed:
    it comes from a matched log signature rather than from a restart count. The
    resource-pressure sentence survives only as a POSSIBILITY, and only when nothing
    was matched -- stated as fact it sent a reader hunting for memory they had.
    """
    cause = known or str(seen.get("cause") or "")
    head = prefix or (f"Rocket.Chat is not becoming ready in {meta.name!r}")
    if cause:
        return NotReadyError(f"{head} - {cause}")
    restarts = int(seen.get("restarts") or 0)
    if restarts >= 2:
        return NotReadyError(
            f"{head} - Rocket.Chat restarted {restarts}x and nothing in its logs "
            f"matches a known cause. Free memory or raise Docker's CPU+RAM if the "
            f"box is loaded, then `houston ready --name {meta.name}`; otherwise "
            f"`houston logs --name {meta.name}` has what happened.")
    return NotReadyError(head)


def _up(name: str, *, pull: bool, emit: Emit, stream_output: bool) -> int:
    if not stream_output:
        return runner.up(name, pull=pull)   # docker draws its own progress on the terminal
    # `echo="docker"` marks this as ECHO rather than narrative: every line of
    # `docker compose pull` comes through here, so a create emits several hundred
    # "Downloading 45.09MB" events. The GUI wants them; the durable log does not, and
    # would spend its whole size cap on one create. `HOUSTON_LOG_ECHO=1` keeps them.
    on_line = lambda ln: info(emit, ln, phase="boot", echo="docker")  # noqa: E731
    if pull:
        runner.compose_stream(name, "pull", on_line=on_line)   # non-fatal, like runner.up
    return runner.compose_stream(name, "up", "-d", "--remove-orphans", on_line=on_line)


def _restore_route(meta: "runner.Metadata", emit: Emit = null_emit) -> None:
    """Re-register a workspace's https name with the edge. Best-effort.

    Never fatal: the workspace is up and usable either way, and failing a reuse
    over the ingress would be the wrong trade.
    """
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    if not (extra.get("tls") and meta.public_url):
        return
    from houston import tls as tlsmod

    host = meta.public_url.split("://", 1)[-1].split("/", 1)[0]
    local = extra.get("tls") == tlsmod.MODE_LOCAL
    try:
        if not edgesvc.running():
            edgesvc.ensure_running(acme_email="" if local else extra.get("tls_email", ""),
                                   acme_staging=bool(extra.get("tls_staging")))
        if local:
            edgesvc.issue_local_cert(host)
        instances = extra.get("instances") if isinstance(extra.get("instances"), int) else 1
        edgesvc.register(meta.name, host, instances=instances, local=local)
        info(emit, f"{host} is served by the edge again", phase="tls")
    except Exception as exc:  # noqa: BLE001 - the workspace is fine regardless
        warn(emit, f"could not restore the https name {host}: {exc}. "
                   "`houston edge status` reports it.", phase="tls")


def _stop_port_forward(pid: int, *, namespace: str = "") -> None:
    """Kill a workspace's port-forward, if it is still ours to kill.

    Best-effort and deliberately narrow, and it was not narrow enough: the check was
    "is this process a kubectl port-forward", which is liveness wearing identity's
    clothes. A recycled pid belonging to ANOTHER workspace's forward -- or another
    user's, on a shared box -- passed it and was signalled, which is precisely the
    failure this docstring already called much worse than leaving a dead pid recorded.

    `namespace` is the discriminator, and every caller knows it. Delegated to
    `k8s.forward_alive` so there is one definition of "ours".
    """
    from houston.services import k8s
    if not k8s.forward_alive(pid, namespace=namespace):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


def finalize(meta: runner.Metadata, emit: Emit):
    try:
        auth = admin.login(meta)
        if rcapi.complete_setup_wizard(meta.root_url, auth, meta.admin_pass):
            info(emit, "setup wizard skipped — no registration needed", phase="post_ready")
        return auth
    except Exception:  # noqa: BLE001 - finalize is best-effort
        return None


def _crash_loop_tick(meta: runner.Metadata, emit: Emit, timeout: float, seen: dict,
                     elapsed: float) -> None:
    """One poll of a boot in progress: is it slow, or is it failing?

    Module-level rather than a closure over `wait_serving`, so a test can patch it and
    so the port has a named thing to translate. `seen` carries the two facts that have
    to survive between ticks.
    """
    # Surface a crash-loop: if RC keeps restarting, boot is slow for a reason
    # (usually CPU/RAM pressure or a boot error), not just "taking a while".
    rc = runner.rc_restart_count(meta.name)
    if rc >= 2 and rc > seen["restarts"]:
        warn(emit, f"Rocket.Chat has restarted {rc}x - checking why", phase="wait")
        # ASK, rather than assert. The old wording named resource pressure as the
        # cause, and `diagnose` -- which exists for exactly this and holds the
        # signature list -- was never consulted anywhere on the readiness path;
        # its only caller is the `docker compose up` failure above. Measured: a
        # workspace whose MONGO_URL pointed at a host that does not exist spent
        # 303s restarting 10x and was then told it was short of RAM, on a box
        # with 5.7 GB free, while its own logs said "Topology is closed" and
        # diagnose.match() on those same logs returned the right answer.
        #
        # Giving up EARLY only when the cause is known. A boot that restarts
        # twice and then settles is ordinary -- v0.71.1 is the whole lesson --
        # so a restart count is not evidence of anything by itself. A matched
        # signature is.
        if seen["cause"] is None:
            seen["cause"] = diagnose.diagnose_failure(meta.name) or ""
        if seen["cause"]:
            raise _readiness_failure(meta, seen, known=str(seen["cause"]))
    seen["restarts"] = max(seen["restarts"], rc)
    pct = max(0.0, min(99.0, elapsed / timeout * 100)) if timeout else None
    info(emit, f"still booting ({int(elapsed)}s)", phase="wait", pct=pct)


def _refuse_if_serving_without_a_database(meta: runner.Metadata) -> None:
    """SERVING IS NOT USABLE, and this is the gap between them."""
    # SERVING IS NOT USABLE. Rocket.Chat answers /api/info with no database behind it,
    # so a workspace whose mongodb had exited passed this and was reported ready,
    # running and healthy -- while `api` and `seed` refused it and pointed the reader
    # back at `ready`, the command that had just said yes.
    why = inspect.degraded_reason(runner.services_by_project().get(meta.project, {}))
    if why:
        raise NotReadyError(
            f"{meta.name!r} is serving, but {why} - Rocket.Chat answers /api/info "
            f"without a database, so this looks ready and no login will work. "
            f"`docker start {meta.project}-{ESSENTIAL_SERVICES[0]}-1`, or "
            f"`houston up --version {meta.rc_version} --name {meta.name}` to "
            f"rebuild the stack.")


def wait_serving(meta: runner.Metadata, emit: Emit, timeout: float) -> dict:
    if topology.of_meta(meta) == topology.KUBERNETES:
        # `rc_state` asks docker whether a CONTAINER is running, so `ready` on a
        # Kubernetes workspace answered "Rocket.Chat container is not running" about
        # a workspace whose pods were fine. It also re-establishes the port-forward,
        # which is the whole reason `ready` is the right place to ask: a forward
        # dies with its pod, and this is the command someone runs when the URL is
        # not answering.
        return _wait_serving_kubernetes(meta, emit, timeout)
    seen: dict = {"restarts": 0, "cause": None}

    def is_alive() -> bool:
        return runner.rc_state(meta.name) in ("running", "restarting", "created")

    def tick(elapsed: float) -> None:
        _crash_loop_tick(meta, emit, timeout, seen, elapsed)

    try:
        served = rcapi.wait_ready(meta.root_url, timeout=timeout, is_alive=is_alive,
                                  on_tick=tick)
    except rcapi.NotReady as exc:
        if seen["cause"] is None:
            seen["cause"] = diagnose.diagnose_failure(meta.name) or ""
        raise _readiness_failure(meta, seen, prefix=str(exc)) from exc
    _refuse_if_serving_without_a_database(meta)
    return served


def _repair_the_port_forward(meta: runner.Metadata, emit: Emit, extra: dict,
                             namespace: str, context: str) -> int:
    """Re-establish the forward and record its pid. A forward dies with its pod, and
    `ready` is exactly when someone asks why the URL stopped answering."""
    from houston.services import k8s

    pid = k8s.ensure_port_forward(
        meta.name, namespace=namespace, context=context,
        host_port=meta.host_port, pid=extra.get("port_forward_pid"),
        bind_host=str(extra.get("bind_host") or ""), emit=emit)
    if pid and pid != extra.get("port_forward_pid"):
        runner.update_meta(meta.name,
                           lambda m: m.extra.update({"port_forward_pid": pid}))
        # AND IN MEMORY, or whoever renders from this `meta` afterwards is
        # reading the pid we just replaced. `ready` repaired a dead forward
        # and then printed "The URL is not published right now" underneath
        # "is serving at <url>" -- both true of different moments, and only
        # on the repair path. That note is the only honest signal about a
        # dead forward, so a false one there teaches people to ignore it.
        if isinstance(meta.extra, dict):
            meta.extra["port_forward_pid"] = pid
    # The pod being Ready is not the URL answering. `kubectl port-forward`
    # returns a pid before it binds the socket, so declaring ready here on
    # the strength of the pid alone is a guess -- and after `restart` it was
    # a wrong one: `ready` exited 0 and the very next request to the URL it
    # had just confirmed got nothing at all. Confirm the socket, and if it
    # is not up yet go round again rather than reporting a workspace the
    # caller cannot reach.
    return pid


def _warn_about_services_with_no_endpoints(meta: runner.Metadata, emit: Emit,
                                           namespace: str, context: str) -> None:
    """Reachable through the forward, and dead to every pod in the cluster."""
    from houston.services import k8s

    # THE SERVICE IS NEVER TRAVERSED by anything on this path, and on
    # this runtime that matters: readiness reads pod status, the
    # port-forward targets the Deployment, and the default deployment
    # is microservices, where in-cluster Service traffic is what
    # carries the product. So a Service whose selector matches nothing
    # looked exactly like a healthy workspace -- reachable through the
    # forward, 200 from the host, and dead to every pod in the cluster.
    #
    # WARNED, not gated: endpoints churn during a rollout and a false
    # negative here would block a boot, which is worse than the defect.
    empty = k8s.services_without_endpoints(meta.name, context=context)
    if empty:
        warn(emit, "no ready pod is behind "
                   + ", ".join(empty)
                   + f" — the URL works because the port-forward goes "
                     f"straight to the Deployment, but nothing inside "
                     f"the cluster can reach {'these' if len(empty) > 1 else 'it'}"
                     f". `kubectl -n {namespace} get endpointslices` "
                     f"shows what is behind each Service.",
             phase="ready")


def _refuse_a_foreign_holder(meta: runner.Metadata, foreign: int) -> int:
    """The port answers, the workspace is ready, and what answered is not Rocket.Chat.

    This was the only runtime that confused occupancy with identity. The Docker path has
    always gone through `rcapi.wait_ready`, which polls /api/info; here readiness was
    concluded from a Ready pod plus "the port answers" and nothing ever asked Rocket.Chat
    anything. A foreign process holding the recorded port therefore passed: `ready`
    printed "is serving at <url>" and exited 0 while a completely different program
    served that URL, and every conclusion a support engineer drew from it was about the
    wrong software. The port is only validated at create time and 3000+ is the most
    contested range on a dev box, so this is an ordinary event.

    Returns the new strike count.
    """
    # WHOSE forward is irrelevant once the workspace itself is ready.
    # The first version raised only when our forward was dead, and the
    # live run found the case that misses: on a dual-stack box kubectl
    # binds `[::1]` quite happily while a squatter holds `127.0.0.1`, so
    # our forward is ALIVE, `localhost` resolves v4-first to the squatter,
    # and this polled to a timeout. Measured -- `ss -ltnp` showed python
    # on 127.0.0.1:3001 and kubectl on [::1]:3001 at the same moment.
    #
    # So the test is the workspace's own state: if Kubernetes says it is
    # ready and the port answers with something that is not Rocket.Chat,
    # then whatever is on that port is not this workspace, and waiting
    # will not change it. Counted rather than acted on at once, because a
    # pod that has just passed its probe may not be serving for another
    # moment, and accusing somebody then would be worse than waiting.
    foreign += 1
    if foreign >= tuning.FOREIGN_PORT_STRIKES:
        raise ConflictError(
            f"port {meta.host_port} is answering, but not with "
            f"Rocket.Chat, and {meta.name!r} is otherwise ready — so "
            f"nothing served on {meta.root_url} can be trusted to be this "
            f"workspace. Something else holds that port. `ss -ltnp | grep "
            f"{meta.host_port}` says what; note it may hold only IPv4 "
            f"while the port-forward has IPv6, which looks healthy from "
            f"houston and wrong from a browser. Free the port, or "
            f"`houston down --name {meta.name}` then `houston up` for "
            f"one that is free.")
    return foreign


def _refuse_a_doomed_pod(meta: runner.Metadata, namespace: str,
                         context: str) -> None:
    from houston.services import k8s

    # Stop waiting for something Kubernetes has already decided cannot happen.
    # A mistyped version or an unreachable registry used to cost the full timeout
    # and then report the timeout rather than the cause.
    doomed = k8s.terminal_pod_failure(meta.name, context=context)
    if doomed:
        pod, reason, message = doomed
        raise CreateFailedError(
            f"{meta.name!r} cannot start: pod {pod} is {reason}"
            + (f" — {message}" if message else "")
            + f". Nothing will change by waiting. `kubectl -n {namespace} "
              f"describe pod {pod}` has the detail.")


def _wait_serving_kubernetes(meta: runner.Metadata, emit: Emit, timeout: float) -> dict:
    """Wait for a Kubernetes workspace to serve, and make sure it is reachable.

    Two jobs, because on this runtime they are different questions. The pod being
    Ready is Kubernetes' answer; the URL answering also needs a live port-forward,
    and a forward dies with its pod. `ready` is exactly when someone asks "why is
    the URL not answering", so it re-establishes one rather than reporting a
    healthy workspace the caller still cannot reach.
    """
    import time as _time

    from houston.services import k8s

    extra = meta.extra if isinstance(meta.extra, dict) else {}
    context = str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    namespace = str(extra.get("namespace") or k8s.namespace_for(meta.name))
    deadline = _time.monotonic() + timeout
    last = 0.0
    #: Consecutive rounds where the workspace is ready and the port answers with
    #: something that is not Rocket.Chat. Grace, not tolerance: it ends in a refusal.
    foreign = 0
    # Pod churn can leave a forward serving once before it dies. Require the same
    # pid to carry two observations before handing its URL over.
    stable_pid = 0
    while _time.monotonic() < deadline:
        if k8s.workspace_ready(meta.name, context=context):
            pid = _repair_the_port_forward(meta, emit, extra, namespace, context)
            # A Ready pod is not proof that its forwarding socket answers. Confirm it
            # instead of handing over a URL on the strength of a pid alone.
            if k8s.forward_reachable(meta.host_port):
                # OCCUPANCY IS NOT IDENTITY: ask Rocket.Chat rather than inferring it
                # from a Ready pod and an answering port. See `_refuse_a_foreign_holder`.
                served = rcapi.api_info(meta.root_url)
                if served is not None:
                    foreign = 0
                    if pid and pid == stable_pid:
                        _warn_about_services_with_no_endpoints(meta, emit, namespace, context)
                        info(emit, f"{meta.name!r} is serving at {meta.root_url}",
                             phase="ready", pct=100)
                        return {"ready": True, "url": meta.root_url}
                    stable_pid = pid
                else:
                    stable_pid = 0
                    foreign = _refuse_a_foreign_holder(meta, foreign)
                extra = dict(extra, port_forward_pid=pid)
            else:
                foreign = 0
                stable_pid = 0
                extra = dict(extra, port_forward_pid=pid)
        else:
            stable_pid = 0
        _refuse_a_doomed_pod(meta, namespace, context)
        now = _time.monotonic()
        if now - last > 15:
            last = now
            info(emit, f"waiting for Rocket.Chat in {namespace}", phase="wait")
        _time.sleep(3.0)
    raise NotReadyError(
        f"Rocket.Chat did not become ready within {int(timeout)}s. "
        f"kubectl -n {namespace} get pods")


def wait_and_finalize(meta: runner.Metadata, emit: Emit = null_emit,
                      timeout: float = 300.0, final: bool = True) -> dict:
    """Wait for the workspace to serve, then finish it off.

    `final` is whether this call is the END of what the user asked for. It is
    for `houston ready`, which is exactly this and nothing else; `up` seeds
    afterwards, restore restores afterwards, and an upgrade has a rollback still
    to consider. All three used to announce phase `done` at 100% here and then
    carry on working -- MEASURED on a real create as `done: ready` at 414s
    followed by 46 more seconds of seeding, and in the GUI as a progress bar
    that fills up and then keeps going.

    A caller that is not the end says the workspace is up, which is the true
    and useful half, and leaves `done` to whoever actually finishes.
    """
    started = time.monotonic()
    served = wait_serving(meta, emit, timeout)
    elapsed = int(time.monotonic() - started)
    auth = finalize(meta, emit)
    postready.run_post_ready(meta, auth, emit)
    # AND THE SEED THE INTERRUPTED CREATE ASKED FOR. The note says the workspace "may
    # be running without its preset configuration or seed data" and names this command
    # as the thing that completes it -- and this used to run post_ready, seed nothing,
    # print "ready" and clear the note anyway. Verified: SIGKILL an `up --wait --seed`
    # after compose has detached, run `ready`, get exit 0, and find a workspace with
    # two users and one channel and no note left saying so. That is worse than leaving
    # the note, because the evidence went with it.
    #
    # From the NOTE, not from meta: the request died with the process, and
    # meta.extra["seed"] is written only after a seed has already succeeded.
    from houston.services import journal
    pending = journal.pending_seed(meta.name)
    if pending.get("seed_here"):
        # The process that wrote this note is still running and will seed itself.
        # `pending_seed` only returns ABANDONED notes, so this is the create-path call
        # inside that same process rather than a later `ready`.
        pending = {}
    if pending and not (isinstance(meta.extra, dict) and meta.extra.get("seed")):
        info(emit, f"finishing the seed the interrupted create asked for "
                   f"(profile: {pending.get('seed_profile') or 'small'})", phase="seed")
        try:
            seeding.run_seed_inline(meta, str(pending.get("seed_profile") or "small"),
                            bool(pending.get("seed_stats")), emit)
        except ReproError as exc:
            # The note STAYS: a seed that could not be finished is exactly what it is
            # for, and clearing it here would delete the only record again.
            warn(emit, f"the interrupted create's seed could not be finished ({exc}) - "
                       f"the note stays; `houston seed --name {meta.name}` retries it",
                 phase="seed")
            running = served.get("version", "?")
            _say_ready(emit, final)
            return {"booted_s": elapsed, "running_version": running}
    journal.clear_kind(journal.CREATE_UNFINISHED, meta.name)
    running = served.get("version", "?")
    if running != "?" and not meta.rc_version.startswith(running):
        warn(emit, f"running version {running} != requested {meta.rc_version}", phase="wait")
    _say_ready(emit, final)
    return {"booted_s": elapsed, "running_version": running}
