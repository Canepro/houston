"""The check modules, and the order the report runs them in.

One module per check SUBJECT, each exposing `check(ctx) -> list[Row]` and nothing else
public. `RUN_ORDER` is that order, and it is the order the rows appear in
`doctor --json` -- which is a published document, so moving a line here moves the
report.

**This module imports nothing, and that is the constraint rather than the style.** Every
check module imports `houston.services.doctor.rows`, and importing a submodule runs its
package initialisers first -- so any import here, of a sibling or of the parent, closes a
cycle. `tools/scc_check.py` gates on it and caught exactly that: `from
houston.services.doctor.rows import Report`, three lines long, inside the function that
used to run the checks. The loop lives in the parent now, which already imports `rows`
legitimately; this file is the ORDER and nothing else.
"""
from __future__ import annotations

#: Module name -> what it looks at. Run in this order; the report is read top to bottom.
RUN_ORDER = (
    "docker",       # is the engine there at all -- everything below degrades without it
    "compose",      # Compose v2, which the whole substrate is
    "kernel",       # the engine's kernel against MongoDB 8 (SERVER-121912)
    "hub",          # Docker Hub auth, because anonymous pulls are rate limited
    "disk",         # free space where images and volumes land
    "memory",       # RAM and swap, which is what check_capacity spends
    "versions",     # whether the RC -> MongoDB pairing can be looked up
    "ports",        # whether the ports houston binds are free
    "install",      # whether this install is newer than the box thinks
    "legacy",       # leftovers from a previous name or layout
    "edge",         # the shared Traefik and the routes it serves
    "identity",     # who can sign in, and whether the state files are private
    "k8s",          # the cluster: tools, reach, storage, ingress, metrics, cloud
    "work",         # work a killed process left half-done, and the event log
    "presets",      # workspaces whose preset points the browser at this machine
)
