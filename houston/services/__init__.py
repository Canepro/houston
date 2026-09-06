"""Service layer: the shared 'brain' behind both the CLI and the web API.

Functions here do the actual work (resolve/build/boot/seed/teardown), raise
`houston.errors.ReproError` subclasses instead of exiting, and report progress
by calling an `emit(Event)` callback rather than printing. The CLI wires `emit`
to terminal output; the web API wires it to a job's SSE stream.
"""

from __future__ import annotations

from houston.services.events import Event, Emit, null_emit

__all__ = ["Event", "Emit", "null_emit"]
