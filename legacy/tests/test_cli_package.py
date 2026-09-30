"""`houston.cli` as a package, and the deadlock its shape exists to prevent.

Splitting a Typer CLI has one non-obvious hazard, and it is not size. The package
initialiser has to import every command module so that `import houston.cli` registers
every command — and each command module has to import the Typer instance to decorate
with. Put that instance in `__init__.py` and the two needs form a circle: `__init__`
starts, begins importing a command module, that module imports `houston.cli` for `app`,
gets the half-initialised module back, and the whole CLI fails to import with
`ImportError: cannot import name 'app' from partially initialized module`.

The cure is that the instances live in a LEAF — `houston/cli/_app.py`, which imports
`typer` and nothing from `houston.cli`. These tests pin the leaf property itself rather
than the symptom, because the symptom only appears once a command module exists to
close the circle, and by then the fix is a rewrite rather than a move.

`--help` is checked here too. It is registration-ordered and frozen at forty fixtures
plus the root listing (`tests/test_frozen.py`), and the thing that would silently
reorder it is exactly what this package is about to do: import thirteen modules.
"""

from __future__ import annotations

import ast
import pathlib

import typer


def test_the_package_imports_cleanly():
    """The whole point. If the leaf rule is broken this raises rather than fails."""
    import houston.cli

    assert callable(houston.cli.main)


def test_the_typer_instances_live_in_a_leaf_that_imports_nothing_from_the_package():
    """Asserted against the source, because at runtime a cycle that has already been
    broken looks exactly like one that never existed."""
    import houston.cli._app as leaf

    tree = ast.parse(pathlib.Path(leaf.__file__).read_text(encoding="utf-8"))
    reaches = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("houston.cli"):
            reaches.append(node.module)
        if isinstance(node, ast.Import):
            reaches += [a.name for a in node.names if a.name.startswith("houston.cli")]
    assert not reaches, f"_app.py is not a leaf: it imports {reaches}"


def test_the_leaf_holds_the_instances_the_package_actually_uses():
    """Identity, not equality: a second `typer.Typer()` would collect its own commands
    and the root listing would come out short."""
    import houston.cli as pkg
    import houston.cli._app as leaf

    assert pkg.app is leaf.app
    assert pkg.skill_app is leaf.skill_app
    assert isinstance(leaf.app, typer.Typer) and isinstance(leaf.skill_app, typer.Typer)


def test_the_sub_app_is_wired_beside_the_commands_not_inside_the_leaf():
    """The leaf CONSTRUCTS; it does not register.

    Not for the reason it is tempting to give: Click lists groups after commands
    regardless of when they were added, so moving `add_typer` does not reorder the root
    help — `skill` is last either way, and the test below proves it rather than
    asserting it. The rule is about what a leaf may do. A module that only builds the
    instances can be imported from anywhere; one that also wires them has an opinion
    about what exists, which is the opinion `__init__` owns.
    """
    import houston.cli._app as leaf

    src = pathlib.Path(leaf.__file__).read_text(encoding="utf-8")
    assert "add_typer" not in src.split('"""', 2)[-1], (
        "the leaf registers as well as constructs")


def test_a_sub_app_lists_after_the_commands_whatever_order_it_was_added_in():
    """Measured, because the docstring above depends on it and the opposite is the
    intuitive guess. If a future Click reverses this, the reasoning for where
    `add_typer` lives changes -- and the root-help fixture would move under it."""
    first, commands_first = typer.Typer(), typer.Typer()
    for parent in (first, commands_first):
        sub = typer.Typer()

        @sub.command("x")
        def _x():
            """sub"""

        if parent is first:
            parent.add_typer(sub, name="zsub")

        @parent.command("alpha")
        def _alpha():
            """a"""

        if parent is commands_first:
            parent.add_typer(sub, name="zsub")

    assert list(typer.main.get_command(first).commands) == ["alpha", "zsub"]
    assert list(typer.main.get_command(commands_first).commands) == ["alpha", "zsub"]


def test_every_command_is_registered_when_the_package_is_imported():
    """A command module that `__init__` forgets to import registers nothing, and the
    only symptom is a command missing from `--help`."""
    import houston.cli as pkg

    names = {c.name or c.callback.__name__ for c in
             typer.main.get_command(pkg.app).commands.values()}
    assert "up" in names and "serve" in names and "skill" in names
    assert len(names) >= 34, f"only {len(names)} top-level commands registered: {sorted(names)}"
