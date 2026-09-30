"""The Typer instances, and nothing else. This module is a LEAF on purpose.

`app` cannot live in `houston/cli/__init__.py`. The package initialiser has to import
the thirteen command modules so that importing `houston.cli` registers every command —
and each of those modules has to import `app` to decorate with it. Putting `app` in
`__init__` makes that a circle: `__init__` runs, starts importing `lifecycle_cmds`,
which imports `houston.cli` for `app`, gets the half-initialised module back, and fails
with `ImportError: cannot import name 'app' from partially initialized module`. It is
not a hypothetical; it is the one non-obvious hazard in splitting a Typer CLI, and the
cure is that the instances sit below everything that uses them.

So: this module imports `typer` and nothing from `houston.cli`. Ever.

`app.add_typer(skill_app, ...)` is deliberately NOT here, and the reason is narrower
than it first looks. Measured: Click lists groups after commands whatever order they were
added in, so moving the call does NOT reorder the root help — `skill` comes last either
way. What the call is, is REGISTRATION, and registration is the thing this module must
not do: a leaf that only constructs can be imported by anything, while a leaf that also
wires is a leaf with an opinion about what exists. The wiring sits beside the commands.
"""
from __future__ import annotations

import typer

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Launch version-matched Rocket.Chat reproduction environments.",
)

skill_app = typer.Typer(
    help="Install the agent skill that teaches a caller to drive houston.")
