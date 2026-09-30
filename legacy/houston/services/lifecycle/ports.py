"""Which host ports a workspace may take, and picking one without racing.

Tier 1. `pick_host_port` holds a lock across the choose-and-claim window, because two
`up` runs that each found the same free port both bind it and the second fails with a
message about Docker rather than about the race that caused it.
"""
from __future__ import annotations

from houston import config, presets, runner
from houston.errors import ConflictError, ValidationError
from houston.services.lifecycle.types import _INTERACTIVE_LOCK_WAIT


def own_ports(name: str) -> set[int]:
    if not name or not runner.exists(name):
        return set()
    try:
        m = runner.read_meta(name)
    except Exception:  # noqa: BLE001 - half-written record
        return set()
    own = {m.host_port}
    n = m.extra.get("instances") if isinstance(m.extra, dict) else None
    if isinstance(n, int) and n > 1:
        own.update(m.host_port + i for i in range(1, n + 1))
    # tls_ports too, or `up --force --https` on an existing repro would not
    # recognise its OWN TLS port as reusable and would drift to the next one --
    # leaking a port number on every recreate, and changing the URL each time.
    for key in ("sidecar_ports", "monitoring_ports", "tls_ports"):
        claimed = m.extra.get(key) if isinstance(m.extra, dict) else None
        if isinstance(claimed, list):
            own.update(int(p) for p in claimed if isinstance(p, int) or str(p).isdigit())
    return own


def check_sidecar_ports(pre: presets.Preset, exclude: str = "") -> None:
    if not pre.ports:
        return
    wanted = set(pre.ports)
    own: set[int] = set()
    for m in runner.list_meta():
        claimed = set(m.extra.get("sidecar_ports") or []) if isinstance(m.extra, dict) else set()
        if m.name == exclude:
            own = claimed
            continue
        overlap = sorted(claimed & wanted)
        if overlap:
            raise ConflictError(
                f"preset {pre.name!r} publishes port(s) {overlap}, already claimed by "
                f"repro {m.name!r} - delete it first: houston down --name {m.name} --volumes")
    for p in sorted(wanted - own):
        if not runner.port_free(p):
            raise ConflictError(f"preset {pre.name!r} needs host port {p}, already in use on this machine")


def check_monitor_ports(exclude: str = "") -> None:
    wanted = set(config.MONITOR_PORTS)
    own: set[int] = set()
    for m in runner.list_meta():
        claimed = set(m.extra.get("monitoring_ports") or []) if isinstance(m.extra, dict) else set()
        if m.name == exclude:
            own = claimed
            continue
        overlap = sorted(claimed & wanted)
        if overlap:
            raise ConflictError(f"monitoring needs port(s) {overlap}, already used by repro {m.name!r} "
                                f"(its monitoring) - stop it first: houston monitor --name {m.name} --off")
    for p in sorted(wanted - own):
        if not runner.port_free(p):
            raise ConflictError(f"monitoring needs host port {p}, already in use on this machine")


#: The lock name port allocation serialises on. `repro_lock` is PER REPRO, and two
#: creates for two different names hold two different locks -- so both could read
#: `used_ports()`, see the same gap and pick the same port, and the heavy pool allows at
#: least two creates at once by design. A box-wide name (no workspace is called this;
#: `_require_valid_name` would reject the leading underscore) makes allocation the one
#: cross-workspace critical section it has to be.
_PORT_LOCK = "_ports"


def pick_host_port(port: int, pre: presets.Preset, exclude: str = "") -> int:
    """Choose a free host port, serialised box-wide.

    Held only for the choice, not for the create: the window that matters is between
    reading `used_ports()` and the caller writing its own record, and the record is
    written by `create_repro` while it still holds its own per-repro lock. Two locks
    rather than one, because holding a box-wide lock across a whole create would
    serialise every concurrent workspace and defeat the heavy pool entirely.
    """
    with runner.repro_lock(_PORT_LOCK, timeout=_INTERACTIVE_LOCK_WAIT):
        return _pick_host_port_locked(port, pre, exclude)


def _pick_host_port_locked(port: int, pre: presets.Preset, exclude: str = "") -> int:
    span = pre.instances + 1 if pre.instances > 1 else 1
    if port:
        if port + span - 1 > runner.PORT_MAX:
            raise ValidationError(f"--port {port}: a {pre.instances}-instance repro needs ports "
                                  f"up to {port + span - 1} (past 65535)")
        own = own_ports(exclude)
        used = runner.used_ports() - own
        for p in range(port, port + span):
            if p in used:
                raise ConflictError(f"port {p} is already claimed by another repro (see `houston list`)")
            if p not in own and not runner.port_free(p):
                raise ConflictError(f"port {p} is already in use on this machine")
        return port
    try:
        return runner.pick_port_range(span) if span > 1 else runner.pick_port()
    except RuntimeError as exc:
        raise ConflictError(str(exc)) from exc
