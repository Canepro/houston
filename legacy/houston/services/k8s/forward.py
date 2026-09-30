"""`kubectl port-forward`, and the question of whether the socket is actually ours.

A forward dies with its pod, so this is the module `ready` leans on when somebody asks
why the URL stopped answering. `forward_reachable` confirms the socket rather than
trusting the pid: kubectl returns one before it binds.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston.services.events import Emit
from pathlib import Path
from houston.services.events import info
from houston.services.events import null_emit
import os
import signal
import socket
from houston import exec as subprocess
import time
from houston.services.events import warn

from houston.services.k8s import ask
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import status as kubestatus
from houston.services.k8s.exec import kube
from houston.services.k8s.monitoring import GRAFANA_DEPLOYMENT, GRAFANA_PORT, MONITORING_NAMESPACE
from houston.services.k8s.names import POD_WAIT_INTERVAL, POD_WAIT_REFUSALS, POD_WAIT_TRIES, RELEASE

def stop_forward(pid: int | None, *, namespace: str, host_port: int | None,
                 emit: Emit = null_emit) -> bool:
    """Retire a recorded port-forward. True if one was signalled.

    `host_port` is the port the forward was PUBLISHED ON, not the one being asked for
    now, and that difference is the whole bug: `up --port 3261` on a workspace already
    forwarded on 3260 asked `forward_alive` about 3261, got False, recorded pid 0 and
    walked away -- leaving the old kubectl alive on 3260 with nothing able to find it
    again, since every later lookup uses the newly recorded port. It survived
    `down --volumes` for the same reason. Measured: pids left on :3260 and :3261 after
    a full teardown.

    Identity is `forward_alive`, deliberately reused rather than reimplemented: it
    already carries the fallback for a host where `kubectl` is a symlink to the `k3s`
    multi-call binary, which rewrites its own command line so /proc reads `kubectl`
    and nothing else. A second identity check here would have been wrong on exactly
    the hosts this runtime is most used on -- verified on this box, where the argv of
    a live forward is a single token.
    """
    if not pid or not forward_alive(pid, namespace=namespace, host_port=host_port):
        return False
    try:
        os.kill(int(pid), signal.SIGTERM)
    except (OSError, ValueError):
        return False
    info(emit, f"stopped the previous port-forward on :{host_port} (pid {pid})",
         phase="boot")
    return True

def _start_and_confirm_forward(bind_host, context, emit, host_port, name, namespace, previous_pid, previous_port, sleep):
    """Start kubectl port-forward and answer with the pid only once it is bound."""
    # `--bind` was accepted and then dropped on this path, which is worse than
    # refusing it: a workspace created with `--bind 0.0.0.0` on a shared box was
    # reachable only from localhost, and nothing said so. kubectl binds 127.0.0.1
    # by default and takes --address, so this is a real setting rather than a
    # Compose-only one.
    # THE OLD ONE GOES FIRST. See `stop_forward`: a `--port` change leaves the
    # previous kubectl alive holding the previous port, with nothing able to find it
    # again because every later lookup asks about the NEW port.
    stop_forward(previous_pid, namespace=namespace,
                 host_port=previous_port if previous_port else host_port, emit=emit)
    argv = ["kubectl", "--context", context, "-n", namespace, "port-forward"]
    if bind_host and bind_host not in ("127.0.0.1", "localhost"):
        argv += ["--address", bind_host]
    argv += [f"deployment/{RELEASE}-rocketchat", f"{host_port}:3000"]
    try:
        proc = subprocess.popen(argv, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True,
                                env=kubeexec.env_for(context))
    except (OSError, subprocess.SubprocessError):
        return 0
    # CONFIRMED, not assumed: `return proc.pid` recorded a pid for a kubectl that had
    # already exited because the port was taken. See `forward_bound`.
    if not forward_bound(proc, host_port, sleep=sleep):
        # WHY IT DID NOT COME UP, rather than one guess applied to every cause. This
        # asserted "Something else probably holds that port" unconditionally, and the
        # commonest cause is the exact opposite: during an upgrade -- or any rolling
        # update -- the pod the forward attached to goes away, kubectl exits, and
        # NOTHING holds the port.
        #
        # MEASURED on a live upgrade: the alarm fired, told the reader to run `down`
        # then `up`, and the next readiness check re-established the forward on its
        # own a few seconds later. A false alarm that prescribes destroying the
        # workspace is worse than no alarm.
        if _listening_inodes(host_port):
            warn(emit, f"the port-forward for {name!r} did not come up on port "
                       f"{host_port}: something else already holds it — `ss -ltnp | "
                       f"grep {host_port}` says what, and `houston down --name "
                       f"{name}` then `houston up` picks a free one.", phase="wait")
        else:
            # Nothing holds it, so this is the pod moving rather than a collision.
            # Recoverable, and usually already recovering.
            warn(emit, f"the port-forward for {name!r} dropped while the pod was "
                       f"moving — nothing holds port {host_port}, so this is not a "
                       f"collision. `houston ready --name {name}` re-establishes it; "
                       f"a create or upgrade does that for you on the next check.",
                 phase="wait")
        return 0
    return proc.pid


def _wait_for_a_pod_to_forward_to(context, emit, name, namespace, sleep):
    """Wait for a Rocket.Chat pod, and say why if none arrives."""
    # RUNNING, not merely existing. `kubectl port-forward` refuses a pod that is
    # still ContainerCreating ("unable to forward port because pod is not
    # running") and exits, which is precisely what happened when this waited only
    # for a pod NAME: the forward was spawned a second after `helm install`, died
    # at once, and the URL never answered. Existence is not reachability.
    # THE EXIT CODE WAS NEVER READ HERE, and empty stdout from a refused call is
    # identical to "the pod is not Running yet". So this waited the full 40 x 3s
    # against a cluster that had been destroyed: measured at 94 seconds and nine
    # "waiting for the Rocket.Chat pod" messages after the control plane was killed.
    # And it never asked `terminal_pod_failure`, though the readiness loop in
    # `lifecycle` does -- so an ErrImagePull burned the whole two minutes before
    # anything named it.
    refused = 0
    for attempt in range(POD_WAIT_TRIES):
        seen = ask.ask_list("pod", context=context, namespace=namespace,
                        selector="app.kubernetes.io/name=rocketchat")
        if seen.refused:
            refused += 1
            if refused >= POD_WAIT_REFUSALS:
                raise DockerError(
                    f"could not ask cluster {context!r} about the Rocket.Chat pod in "
                    f"{namespace} ({refused} attempts): {seen.why()}. Waiting longer "
                    f"will not help while the cluster cannot be reached.")
            sleep(POD_WAIT_INTERVAL)
            continue
        refused = 0
        phases = [((it.get("status") or {}).get("phase") or "") for it in seen.items]
        if "Running" in phases:
            break
        # Stop waiting for something Kubernetes has already decided cannot happen --
        # the same check, and the same reasoning, as the readiness loop.
        doomed = kubestatus.terminal_pod_failure(name, context=context)
        if doomed:
            pod, reason, message = doomed
            raise CreateFailedError(
                f"{name!r} cannot start: pod {pod} is {reason}"
                + (f" — {message}" if message else "")
                + f". Nothing will change by waiting. `kubectl -n {namespace} "
                  f"describe pod {pod}` has the detail.")
        if attempt % 4 == 0:
            info(emit, "waiting for the Rocket.Chat pod", phase="wait")
        sleep(POD_WAIT_INTERVAL)


def port_forward(name: str, *, namespace: str, context: str, host_port: int,
                 bind_host: str = "", previous_pid: int = 0,
                 previous_port: int | None = None,
                 emit: Emit = null_emit,
                 sleep=time.sleep) -> int:
    """Publish a workspace on a host port. Returns the pid, or 0.

    Detached with `start_new_session`, so it outlives the `up` that started it --
    the workspace has to stay reachable after the command returns, exactly as a
    published Compose port does.

    **Forwards to the DEPLOYMENT, not the Service.** `port-forward svc/...` needs a
    ready ENDPOINT, and a Service has none until its pod passes readiness -- so the
    first version started the forward immediately after `helm install`, kubectl
    found nothing to attach to and exited, and the URL `up` printed never answered.
    A deployment target only needs a pod to exist, which is the difference between
    a URL that works and one that lies.

    It still waits for that pod, briefly. A forward started before the ReplicaSet
    has created anything exits just the same.

    A port-forward dies with its pod, which is a real difference from Compose --
    hence `ensure_port_forward`, which `ready` and `start` use to re-establish it.
    """
    _wait_for_a_pod_to_forward_to(context, emit, name, namespace, sleep)
    return _start_and_confirm_forward(bind_host, context, emit, host_port, name, namespace, previous_pid, previous_port, sleep)

#: A scenario Service wearing this label is published on the host port it names.
#: The label rather than a table here, because the adapter that creates the Service
#: is the thing that knows it has a UI -- and a table would be a second place to
#: declare a port, which is how two registries disagree. See presets/ldap.py.
UI_PORT_LABEL = "houston.io/ui-port"

#: Up to two minutes for a scenario's workload to have a ready endpoint. Keycloak
#: imports a realm on first boot and takes about forty seconds of it.
ENDPOINT_WAIT_TRIES = 60

ENDPOINT_WAIT_INTERVAL = 2.0


def _listed_service(line: str):
    """Parse one service publication row, or return None for malformed output."""
    parts = line.split()
    if len(parts) not in (3, 4):
        return None
    svc, host, target = parts[:3]
    deploy = parts[3] if len(parts) == 4 else svc
    try:
        return svc, int(host), int(target), deploy
    except ValueError:
        return None


def _scenario_forward_argv(bind_host, context, deploy, host_p, namespace, target_p):
    """Build the deployment port-forward command for a published scenario UI."""
    argv = ["kubectl", "--context", context, "-n", namespace, "port-forward"]
    if bind_host and bind_host not in ("127.0.0.1", "localhost"):
        argv += ["--address", bind_host]
    argv += [f"deployment/{deploy}", f"{host_p}:{target_p}"]
    return argv


def _forward_listed_service(bind_host, context, emit, forwards, namespace, res, sleep):
    """Publish each scenario Service that asks to be published, one line at a time."""
    for line in (res.stdout or "").splitlines():
        listed = _listed_service(line)
        if listed is None:
            continue
        svc, host_p, target_p, deploy = listed
        # WAIT FOR A READY ENDPOINT FIRST. `kubectl port-forward svc/...` binds the
        # local socket immediately and only then dials a pod -- so a forward started
        # while the workload is still booting passes a TCP check on the local side,
        # fails upstream, and exits. Keycloak takes ~40s to import its realm, and
        # that is exactly what happened: "keycloak published at http://localhost:8081"
        # followed by a connection refused a minute later.
        #
        # Binding a socket is not the same as the backend answering, which is the
        # same lesson as `svc/` needing ready endpoints -- learned here for the
        # third time, on the third kind of forward.
        for _ in range(ENDPOINT_WAIT_TRIES):
            # EndpointSlice, not the deprecated `endpoints`: kubectl warns on every
            # call to the old one ("v1 Endpoints is deprecated in v1.33+") and this is
            # a WAIT LOOP, so the day it stops being served this would spin to its
            # timeout rather than fail visibly. `discovery.k8s.io/v1` is GA from 1.21,
            # this module's kubectl floor.
            counts = kubestatus.service_ready_addresses(namespace, context=context)
            if counts and counts.get(svc, 0) > 0:
                break
            sleep(ENDPOINT_WAIT_INTERVAL)
        else:
            warn(emit, f"{svc} has no ready endpoint yet; publish it when it is up: "
                       f"kubectl -n {namespace} port-forward svc/{svc} "
                       f"{host_p}:{target_p}", phase="boot")
            continue
        # deployment/, NOT svc/. A Service forward dies when its endpoint churns --
        # which is exactly what happened to a live OIDC workspace: Keycloak was
        # 1/1 Running, the recorded pid was gone, and nothing answered on 8085. The
        # workspace's own forward learned this and uses deployment/; scenarios then
        # reintroduced it. Our adapters name the Deployment and the Service
        # identically, which `test_a_scenario_names_its_deployment_and_service_alike`
        # holds them to.
        argv = _scenario_forward_argv(
            bind_host, context, deploy, host_p, namespace, target_p)
        try:
            proc = subprocess.popen(argv, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True,
                                    env=kubeexec.env_for(context))
        except (OSError, subprocess.SubprocessError):
            continue
        # Confirmed, not assumed -- the same rule the workspace URL and Grafana both
        # had to learn: port-forward returns a pid before it binds the socket. And
        # `forward_bound` rather than `forward_reachable`, because the port answering
        # is not evidence that OUR kubectl is the thing answering.
        if forward_bound(proc, host_p):
            forwards[host_p] = proc.pid
            info(emit, f"{svc} published at http://localhost:{host_p}", phase="boot")
        else:
            warn(emit, f"{svc} is running but http://localhost:{host_p} is not "
                       f"answering yet; `kubectl -n {namespace} port-forward "
                       f"svc/{svc} {host_p}:{target_p}` re-establishes it",
                 phase="boot")


def scenario_ui_forwards(name: str, *, namespace: str, context: str,
                         bind_host: str = "", emit: Emit = null_emit,
                         sleep=time.sleep) -> dict:
    """Publish every scenario Service that asks to be published. Returns {port: pid}.

    Compose gives a preset's UI a host port for free; here it is a port-forward, for
    the reasons NodePort cannot serve: its range is 30000-32767 so the port would not
    MATCH the Compose one, kind's nodes are unreachable from the host on macOS and
    Windows, and `extraPortMappings` is fixed when the cluster is created -- which
    for a cluster shared by every workspace would mean recreating it to add a preset.

    Forwarded to the SERVICE here, not a Deployment: by this point the workload is
    installed and its endpoints are ready, and a Service is the stable name if the
    pod is later replaced.
    """
    res = kube.run(["kubectl", "--context", context, "-n", namespace, "get", "svc",
               "-l", UI_PORT_LABEL, "-o",
               "jsonpath={range .items[*]}{.metadata.name}{\" \"}"
               "{.metadata.labels.houston\\.io/ui-port}{\" \"}"
               "{.spec.ports[0].targetPort}{\" \"}"
               "{.metadata.labels.houston\\.io/ui-deployment}{\"\\n\"}{end}"],
              own=vocab.is_ours(context))
    forwards: dict[int, int] = {}
    _forward_listed_service(bind_host, context, emit, forwards, namespace, res,
                            sleep)
    return forwards

def forward_alive(pid: int | None, *, namespace: str = "",
                  host_port: int | None = None) -> bool:
    """Whether `pid` is OUR port-forward -- not merely someone's.

    A pid alone is not enough: the OS recycles them. This used to accept any process
    whose command line mentioned `port-forward`, which is a liveness check dressed as
    an identity check. A recycled pid belonging to a different workspace's forward --
    or another user's, on a shared box -- passed it, so houston could believe a
    workspace was reachable when it was not, decline to start the forward it needed,
    and signal a stranger's process at teardown.

    The argv already carries the proof: `kubectl --context X -n <namespace>
    port-forward deployment/... <host>:<container>`. So identity comes from the
    cmdline and needs no extra bookkeeping. Matched as whole NUL-separated tokens,
    because a substring test lets `3000` match `13000`.

    `namespace`/`host_port` are optional so the check degrades to what it did before
    where a caller genuinely has neither; every caller in houston passes both.
    """
    if not pid:
        return False
    try:
        raw = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
    except (OSError, ValueError, TypeError):
        return False
    argv = [t for t in raw.decode("utf-8", "replace").split("\0") if t]
    # AN ARGV OF ONE IS NOT AN ARGV THAT DISAGREES. On a host where `kubectl` is a
    # symlink to `k3s` -- which is every k3s host, and this is how k3s ships kubectl --
    # the multi-call binary rewrites its own command line when it dispatches, so
    # /proc/<pid>/cmdline reads `kubectl` and then nothing. Measured: `ss -ltnp` showed
    # that very pid holding both :3000 sockets while this returned False.
    #
    # Reading that as "the forward is gone" made `ensure_port_forward` respawn onto a
    # port its own live forward already held, on every call, and told the reader the
    # URL was not published while it answered 200. So a command line that carries no
    # arguments to check is "I cannot identify it this way", not a mismatch -- the
    # distinction this module is otherwise built on.
    if len(argv) <= 1:
        return _forward_alive_without_argv(pid, host_port=host_port)
    if "port-forward" not in argv:
        return False
    if namespace and namespace not in argv:
        return False
    if host_port is not None and not any(
            t.startswith(f"{host_port}:") for t in argv):
        return False
    return True

def _forward_alive_without_argv(pid: int, *, host_port: int | None) -> bool:
    """Fallback identity when the process hid its own arguments.

    Three facts together, and none of them alone would do: the pid came from OUR
    record, the process is still a `kubectl`, and the port it was started for is
    actually held. Pid recycling is what the argv check exists to defeat, and a
    recycled pid that is also a kubectl that is also listening on exactly the port we
    recorded is a coincidence worth accepting -- the alternative is calling every
    healthy forward on every k3s host dead.
    """
    try:
        comm = Path(f"/proc/{int(pid)}/comm").read_text(encoding="utf-8").strip()
    except (OSError, ValueError, TypeError):
        return False
    if comm not in ("kubectl", "k3s"):
        return False
    if host_port is None:
        return True
    # `pid_owns_port`, not `forward_reachable`: "the port answers" is satisfied by
    # whoever holds it, which is exactly the confusion this fallback exists inside.
    return pid_owns_port(int(pid), int(host_port))

def ensure_port_forward(name: str, *, namespace: str, context: str, host_port: int,
                        pid: int | None = None, bind_host: str = "",
                        emit: Emit = null_emit) -> int:
    """Return a live port-forward pid, starting one if the recorded one is gone.

    A forward dies with its pod, so `ready` and `start` call this rather than
    assuming the one written at create time is still there. Idempotent: an
    already-live forward is left alone rather than duplicated onto a busy port.
    """
    if forward_alive(pid, namespace=namespace, host_port=host_port):
        return int(pid)
    # The recorded pid is handed on as the one to retire: it is not alive ON THIS
    # PORT, which is a different statement from "it is not alive" -- a `--port`
    # change leaves it running on the old one.
    return port_forward(name, namespace=namespace, context=context,
                        host_port=host_port, bind_host=bind_host,
                        previous_pid=int(pid or 0), previous_port=host_port,
                        emit=emit)

def forward_reachable(host_port: int, *, tries: int = 20, interval: float = 0.5,
                      sleep=time.sleep) -> bool:
    """Whether SOMETHING is listening on the host port yet. Occupancy, not identity.

    `kubectl port-forward` returns a pid long before it has bound the socket, so a
    URL printed straight after spawning it is a guess. The workspace path learned
    this the hard way; the Grafana path repeated it and the matrix caught it --
    `monitor` reported attached and exit 0, and a curl a moment later got nothing.

    **It cannot tell you WHOSE socket it is.** A foreign process holding the port
    answers this exactly as our own forward does, so nothing may conclude "the
    workspace is serving" from this alone -- `forward_bound` answers the process
    question and `rcapi.api_info` the "is it actually Rocket.Chat" one.
    """

    for _ in range(tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.0)
            if sock.connect_ex(("127.0.0.1", int(host_port))) == 0:
                return True
        sleep(interval)
    return False

def _listening_inodes(port: int) -> set[str]:
    """Socket inodes LISTENING on `port`, from /proc/net/tcp{,6}."""
    out: set[str] = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(path).read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            # 0A is TCP_LISTEN; anything else is a connection, not a bind.
            if len(fields) < 10 or fields[3] != "0A":
                continue
            try:
                if int(fields[1].split(":")[1], 16) == int(port):
                    out.add(fields[9])
            except (ValueError, IndexError):
                continue
    return out

def pid_owns_port(pid: int, port: int) -> bool:
    """Whether THIS pid holds a listening socket on `port`.

    Ownership, and it is answered rather than timed. Every other way of asking --
    "is the port up?", "is the child still alive?" -- is a race against a kubectl
    that has not failed yet, and `forward_bound` lost that race 3 times out of 3
    against a squatter: `poll()` is None for a few hundred milliseconds after
    `Popen` while the socket is answered instantly by whoever already holds it.
    Matching the process's own socket inodes against the listeners on the port has
    no such window.

    An unreadable /proc entry (a process that is not ours) yields no inodes and so
    answers False, which is the safe direction.
    """
    inodes = _listening_inodes(port)
    if not inodes:
        return False
    mine = _socket_inodes_of(pid)
    if not mine:
        return False
    return bool(inodes & mine)

def _socket_inodes_of(pid: int) -> set[str]:
    """The socket inodes this pid holds open. Empty for a process we cannot read."""
    try:
        fds = list((Path(f"/proc/{int(pid)}") / "fd").iterdir())
    except (OSError, ValueError, TypeError):
        return set()
    out: set[str] = set()
    for fd in fds:
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith("socket:["):
            out.add(target[8:-1])
    return out

def pid_owns_port_exclusively(pid: int, port: int) -> bool:
    """Whether EVERY listener on `port` belongs to `pid` -- no other family, no
    other process.

    `pid_owns_port` answers "is one of these sockets mine", and that is not the same
    question when two processes can hold the same port on different families.
    `kubectl port-forward` binds "localhost", which is BOTH 127.0.0.1 and [::1] --
    and if an IPv4-only process already holds the port, kubectl does not fail: it
    binds [::1] alone and runs happily. `pid_owns_port` then said yes, `forward_bound`
    certified the forward, and houston published `http://localhost:P` while every
    IPv4 client reached the squatter and every IPv6 client reached Rocket.Chat.
    Measured exactly that: kubectl on `[::1]:3250` only, `127.0.0.1:3250` answering
    a different program, and houston reporting the workspace as reachable.

    The split is the failure, so the test is exclusivity rather than presence. This
    is deliberately not solved by forcing `--address 127.0.0.1`: houston publishes
    `http://localhost:P`, and on a box whose `localhost` resolves to `::1` first --
    this one does -- binding IPv4 only would break the URL for everybody.
    """
    inodes = _listening_inodes(port)
    if not inodes:
        return False
    return inodes <= _socket_inodes_of(pid)

def forward_bound(proc: subprocess.Process, host_port: int, *, tries: int = 20,
                  interval: float = 0.5, sleep=time.sleep) -> bool:
    """Whether THIS child actually got the socket. Waits for one answer or the other.

    `kubectl port-forward` cannot share a port: if something already holds it, kubectl
    prints `Unable to listen on port N: bind: address already in use` and exits within
    milliseconds. Returning `proc.pid` regardless recorded a pid that was already
    dead -- and because `forward_reachable` only asks whether the port ANSWERS, and
    the squatter answers, `ready` then certified the workspace's URL while a different
    program served it. Every conclusion drawn from that URL was about the wrong
    software, which is the worst thing this module can do.

    The child exiting is a definite no; the socket answering while the child lives is
    a yes; neither yet means keep waiting.

    stderr stays on DEVNULL rather than a pipe. This process is detached and outlives
    the command, so nothing would be reading that pipe -- kubectl writes a line per
    dropped connection and would eventually fill the buffer and block the forward
    itself. `proc.poll()` answers the only question needed here.
    """
    for _ in range(tries):
        if proc.poll() is not None:
            return False
        # OUR CHILD'S SOCKET, not "a socket". Asking whether the PORT answers made
        # this return True against a squatter every time, in a tenth of a
        # millisecond: the port was answered by the process already holding it while
        # our kubectl had not yet got as far as failing to bind. The warning this
        # function exists to produce therefore never fired in the one scenario its
        # docstring describes, and the dead pid was recorded after all.
        if pid_owns_port_exclusively(proc.pid, host_port):
            return True
        sleep(interval)
    return proc.poll() is None and pid_owns_port_exclusively(proc.pid, host_port)

def grafana_forward(*, context: str, host_port: int, bind_host: str = "") -> int:
    """Publish Grafana on a host port. Returns the pid, or 0.

    Same deployment-not-Service rule as the workspace forward, for the same reason:
    a Service with no ready endpoint makes kubectl exit immediately.
    """
    argv = ["kubectl", "--context", context, "-n", MONITORING_NAMESPACE,
            "port-forward"]
    if bind_host and bind_host not in ("127.0.0.1", "localhost"):
        argv += ["--address", bind_host]
    argv += [f"deployment/{GRAFANA_DEPLOYMENT}", f"{host_port}:{GRAFANA_PORT}"]
    try:
        proc = subprocess.popen(argv, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True,
                                env=kubeexec.env_for(context))
    except (OSError, subprocess.SubprocessError):
        return 0
    # Same rule as the workspace forward. This path has form: it is where "reported
    # attached and exit 0, and a curl a moment later got nothing" was measured.
    if not forward_bound(proc, host_port):
        return 0
    return proc.pid
