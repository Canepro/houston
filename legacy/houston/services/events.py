"""Progress event model shared by every long-running service function.

A single stream type unifies the two progress channels that exist today: Python
`log=` callbacks (seed, config-import) and streamed subprocess output (docker,
k6). A service function takes `emit: Emit` and calls it with `Event`s; the CLI
prints them, the web API buffers them per job and pushes them over SSE.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Event:
    message: str
    phase: str = "info"        # pull|boot|wait|post_ready|seed|k6|restore|done|...
    level: str = "info"        # info|warn|error
    pct: float | None = None   # 0-100 when known
    data: dict[str, Any] = field(default_factory=dict)
    terminal: bool = False     # last event of a job; `data` carries the Result
    code: str = ""             # stable warning code; prose remains for humans

    def as_dict(self) -> dict:
        return {"message": self.message, "phase": self.phase, "level": self.level,
                "pct": self.pct, "data": self.data, "terminal": self.terminal,
                "code": self.code}


# An emitter is any callable taking one Event. Kept as a plain callable (not a
# class) so tests can pass `events.append` and the CLI can pass a small adapter.
Emit = Callable[[Event], None]

# Sinks are keyed because two independently created front ends may want the same
# durable destination. The count is ownership, not invocation multiplicity: two live
# apps lease eventlog once each, while each Event still reaches it exactly once.
_SINK_LOCK = threading.RLock()
_SINKS: dict[str, tuple[Emit, int]] = {}


def install_sink(key: str, fn: Emit) -> Callable[[], None]:
    """Lease one keyed sink and return an idempotent release callback.

    Reinstalling the exact callable adds an ownership lease. Reusing a key for a
    different callable is an error rather than a silent replacement: otherwise one
    app starting could redirect another app's live event stream, and the first app's
    shutdown could then remove the replacement.
    """
    if not key:
        raise ValueError("an event sink key cannot be empty")
    with _SINK_LOCK:
        current = _SINKS.get(key)
        if current is not None and current[0] is not fn:
            raise ValueError(f"event sink {key!r} is already installed")
        _SINKS[key] = (fn, 1 if current is None else current[1] + 1)

    released = False

    def unregister() -> None:
        nonlocal released
        with _SINK_LOCK:
            if released:
                return
            released = True
            current = _SINKS.get(key)
            if current is None or current[0] is not fn:
                return
            if current[1] == 1:
                del _SINKS[key]
            else:
                _SINKS[key] = (fn, current[1] - 1)

    return unregister


def null_emit(_: Event) -> None:
    """Discard events (default for callers that don't care about progress)."""


def _tee(ev: "Event") -> None:
    """Deliver the event to a snapshot of the currently installed sinks.

    HERE, because this module is the single funnel every long-running function goes
    through -- so a sink covers ~125 emit sites without one of them being touched. The
    registry is the dependency inversion: this L0 module imports no sink.

    Snapshot under the lock and invoke outside it. A sink may install/uninstall while
    handling an event, and slow file I/O must not prevent another lifecycle changing
    its lease. Each sink is isolated: logging must never break the operation it
    describes or prevent a later sink from running.
    """
    with _SINK_LOCK:
        sinks = [fn for fn, _leases in _SINKS.values()]
    for sink in sinks:
        try:
            sink(ev)
        except Exception:  # noqa: BLE001 - one broken sink must not block anything
            pass


def info(emit: Emit, message: str, *, phase: str = "info", pct: float | None = None,
         **data: Any) -> None:
    ev = Event(message, phase=phase, pct=pct, data=data)
    _tee(ev)
    emit(ev)


def warn(emit: Emit, message: str, *, phase: str = "info", code: str = "WARNING",
         **data: Any) -> None:
    ev = Event(message, phase=phase, level="warn", data=data, code=code)
    _tee(ev)
    emit(ev)
