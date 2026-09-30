"""ports -- see the package docstring."""
from __future__ import annotations

import socket
import sys

from houston.runner import record as runner_record

def used_ports() -> set[int]:
    ports: set[int] = set()
    for m in runner_record.list_meta():
        ports.add(m.host_port)
        # A multi-instance repro also occupies host_port+1..+N (direct instance
        # access), so those are claimed too.
        n = m.extra.get("instances") if isinstance(m.extra, dict) else None
        if isinstance(n, int) and n > 1:
            ports.update(m.host_port + i for i in range(1, n + 1))
        # Preset side services (Keycloak/Mailpit/MinIO…) and the monitoring
        # add-on (Prometheus/Grafana) publish fixed host ports recorded at `up` —
        # claimed too, so RC port allocation avoids them.
        for key in ("sidecar_ports", "monitoring_ports", "tls_ports"):
            claimed = m.extra.get(key) if isinstance(m.extra, dict) else None
            if isinstance(claimed, list):
                ports.update(int(p) for p in claimed if isinstance(p, int) or str(p).isdigit())
    return ports

PORT_MAX = 65535

def port_free(port: int, host: str = "") -> bool:
    """True if `port` is free to publish on the host right now.

    `host` narrows the question to one interface. It matters because the wildcard
    bind below reports busy for EVERY address as soon as anything holds the port
    on 0.0.0.0 — correct for "can I publish this everywhere", wrong for "is
    203.0.113.10:443 free", which is the dedicated-IP escape hatch: two processes
    CAN hold the same port on different IPs (verified on 172.16.0.2 and .3 at
    once). Without this the front door holding 443 on 0.0.0.0 made every other
    address look taken.
    """
    probe_host = host or "127.0.0.1"
    # First: is something already LISTENING there? A wildcard bind with
    # SO_REUSEADDR (below) can miss a docker publish on 127.0.0.1:<port> (repros
    # bind loopback), so probe it directly — connect success == in use.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        try:
            if probe.connect_ex((probe_host, port)) == 0:
                return False
        except OSError:
            return False
    # Then: can we actually bind it? (catches reserved-but-not-listening ports.)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        # On Unix, SO_REUSEADDR lets us probe a port that's only in TIME_WAIT.
        # On Windows it would let bind() succeed even for an active listener
        # (a false "free"), so skip it there.
        if sys.platform != "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host or "0.0.0.0", port))
            return True
        except PermissionError:
            # A privileged port (<1024) cannot be bound by an unprivileged user,
            # but the DOCKER DAEMON can — it runs as root, so `ports: 443:443`
            # publishes fine. Treating EACCES as "in use" made `up --https
            # --domain ...` refuse 443 on every non-root machine, with nothing
            # actually listening on it. Nobody is holding it; we just can't probe
            # this way. The connect() check above already caught a real listener.
            return True
        except (OSError, OverflowError):
            return False

def pick_port(start: int = 3000) -> int:
    """Lowest port >= start not claimed by another repro AND free on the host.

    Bounded: raises RuntimeError instead of scanning past 65535 (which happens
    when the host can't bind anything, e.g. sandboxed environments)."""
    used = used_ports()
    port = start
    while port in used or not port_free(port):
        port += 1
        if port > PORT_MAX:
            raise RuntimeError(
                f"no free host port found (scanned {start}-{PORT_MAX}) — "
                "can this environment bind TCP ports at all?"
            )
    return port

def pick_port_range(count: int, start: int = 3000) -> int:
    """Lowest base port with `count` consecutive ports all unclaimed AND free.

    Used by multi-instance repros, which need one port for the load balancer plus
    one per instance (the block [base, base+count)). Bounded like pick_port."""
    used = used_ports()
    base = start
    while not all((base + i) not in used and port_free(base + i) for i in range(count)):
        base += 1
        if base + count - 1 > PORT_MAX:
            raise RuntimeError(
                f"no free block of {count} consecutive host ports found "
                f"(scanned from {start}) — can this environment bind TCP ports at all?"
            )
    return base
