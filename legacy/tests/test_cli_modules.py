"""The CLI package's shape: what may import what, and what the leaves may do.

`houston/cli/` is thirteen modules where it was one 4,806-line file. Three properties
have to survive that, and none of them is visible in the output of any command:

* **`_app.py`, `_common.py` and `_render.py` are leaves.** None may import
  `houston.cli`, because the package initialiser imports the command modules and the
  command modules import the leaves — a leaf reaching back up closes the circle and
  `import houston.cli` stops working entirely.
* **The re-exports are the same objects.** `houston.cli._fail` and
  `houston.cli._common._fail` must be one function. Two would mean the suite patches or
  reads one while the commands call the other.
* **`_render.py` renders and nothing else.** It does not import the error or JSON
  machinery, because a renderer that can fail is a renderer that will, halfway through
  a panel, with the exit path decided by whichever helper noticed first.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from houston import cli
from houston.cli import (_app, _common, _perf_render, _perf_run, _render,
                         cluster_cmds,
                         data_cmds, gui_cmds, https_cmds, inspect_cmds,
                         lifecycle_cmds, other_cmds, perf_cmds, rest_cmds,
                         settings_cmds)

#: The leaves, LOWEST FIRST. A leaf may import one below it and nothing above: `_app`
#: constructs the Typer instances and depends on nothing, `_common` and `_render` are
#: peers over it, and `_perf_render` sits on `_render` because the load-test panels reuse
#: the ASCII fallback. Anything that imports upward -- or imports the package at all --
#: closes the circle the initialiser cannot survive.
LEAF_ORDER = (_app, _common, _render, _perf_render, _perf_run)
LEAVES = LEAF_ORDER
COMMAND_MODULES = (lifecycle_cmds, inspect_cmds, settings_cmds, data_cmds,
                   perf_cmds, rest_cmds, gui_cmds, cluster_cmds, https_cmds,
                   other_cmds)


def _imports(module) -> list[str]:
    tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.append(node.module or "")
        elif isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
    return names


@pytest.mark.parametrize("leaf", LEAVES, ids=lambda m: m.__name__)
def test_a_leaf_imports_only_leaves_below_it_and_never_the_package(leaf):
    below = {m.__name__ for m in LEAF_ORDER[:LEAF_ORDER.index(leaf)]}
    reaches = [n for n in _imports(leaf)
               if (n == "houston.cli" or n.startswith("houston.cli.")) and n not in below]
    assert not reaches, f"{leaf.__name__} is not a leaf: it imports {reaches}"


def test_the_package_re_exports_the_leaves_by_identity_not_by_copy():
    for name in ("_fail", "_err", "_cli_emit", "_resolve_name", "_require_engine",
                 "_cli_actor", "_login", "_run_and_echo"):
        assert getattr(cli, name) is getattr(_common, name), name
    for name in ("_summary_panel", "_render_create_result", "_print_notes",
                 "_human_bytes", "_fmt_duration", "_tls_label"):
        assert getattr(cli, name) is getattr(_render, name), name


def test_the_renderer_cannot_fail_or_answer():
    """It formats. Deciding and exiting belong to `_common`, which is where the
    `--json` envelope contract is honoured; a renderer that can also exit would give
    the contract a second, unwatched exit."""
    reaches = set(_imports(_render))
    for forbidden in ("houston.errors", "houston.jsonout", "houston.rcapi"):
        assert forbidden not in reaches, f"_render imports {forbidden}"
    src = pathlib.Path(_render.__file__).read_text(encoding="utf-8")
    assert "typer.Exit" not in src, "_render raises typer.Exit, so rendering can exit"


def test_the_error_funnel_is_still_one_function_per_shape():
    """`_fail` and `_err` are where a CLI failure becomes a red line and an exit code,
    or exactly one JSON envelope. Seventy-five error paths that predate `jsonout`
    honour the contract only because they route through these two."""
    assert _common._fail.__module__ == "houston.cli._common"
    assert _common._err.__module__ == "houston.cli._common"
    src = pathlib.Path(_common.__file__).read_text(encoding="utf-8")
    assert "jsonout" in src, "the JSON envelope is no longer reached from the funnel"


@pytest.mark.parametrize("module", COMMAND_MODULES, ids=lambda m: m.__name__)
def test_a_command_module_never_imports_the_package_either(module):
    """Same circle, one layer out. A command module may reach the leaves; reaching
    `houston.cli` itself would deadlock the initialiser that imports it."""
    #: The two sibling reaches the package allows, both in the direction of use:
    #: `up --seed` runs `seed`'s helper, and `serve --domain` reports TLS the way `edge`
    #: does. Anything else, and certainly `houston.cli` itself, is a cycle.
    allowed = {"houston.cli.data_cmds", "houston.cli.https_cmds"}
    reaches = [n for n in _imports(module)
               if (n == "houston.cli"
                   or (n.startswith("houston.cli.")
                       and not n.split(".")[-1].startswith("_")
                       and n not in allowed))]
    assert not reaches, f"{module.__name__} imports {reaches}"


def test_the_registration_table_is_the_whole_command_surface():
    assert len(cli.REGISTRATION_ORDER) == 40
    seen = [name for _mod, name, _fn in cli.REGISTRATION_ORDER]
    assert len(set(seen)) == len(seen), "a command name is registered twice"
    for module, name, func in cli.REGISTRATION_ORDER:
        owner = cli if not module else __import__(f"houston.cli.{module}",
                                                  fromlist=["_"])
        assert callable(getattr(owner, func)), f"{module or 'cli'}.{func} for {name!r}"


def test_the_registration_table_is_the_root_help_order():
    """`--help` is registration-ordered and the root listing is a frozen fixture. This
    is the same statement one level up: the TABLE is what decides that order, so a line
    moved in it is a published change even before the fixture is re-captured."""
    import re

    fixture = (pathlib.Path(__file__).parent / "fixtures" / "help-root.txt").read_text()
    commands = fixture.split("Commands", 1)[1]
    listed = [m.group(1) for m in re.finditer(r"^ ([a-z][a-z-]*) {2,}\S", commands, re.M)]
    # The two `skill` sub-commands hang off their own Typer and never appear here; the
    # group itself does, and Click puts a group after every command whatever the order.
    table = [n for _m, n, _f in cli.REGISTRATION_ORDER if n not in cli.SKILL_COMMANDS]
    assert listed == table + ["skill"], (
        f"the root help order and REGISTRATION_ORDER disagree:\n"
        f"  help  {listed}\n  table {table + ['skill']}")


def test_nothing_registers_a_command_outside_the_table():
    """A stray `@app.command()` in a command module would register on import, in
    whatever order the table happened to import that module -- silently reordering a
    frozen surface and bypassing the one place the order is written down."""
    package = pathlib.Path(cli.__file__).parent
    strays = []
    for path in sorted(package.rglob("*.py")):
        src = path.read_text(encoding="utf-8")
        for line in src.splitlines():
            if line.lstrip().startswith(("@app.command", "@skill_app.command")):
                strays.append(f"{path.name}: {line.strip()}")
    assert not strays, f"commands registered outside REGISTRATION_ORDER: {strays}"


def test_the_package_initialiser_imports_no_command_module_by_name():
    """The cycle `tools/scc_check.py` found, kept out by construction.

    Importing `houston.cli.data_cmds` runs this initialiser first, and every command
    module reaches back here through `_common` -- so one `from houston.cli.data_cmds
    import ...` at the top of `__init__.py` closes a nine-module loop. It did: the gate
    reported exactly that. Command names resolve through `__getattr__` instead, which
    leaves no static edge, and `_register()` imports by string.
    """
    tree = ast.parse(pathlib.Path(cli.__file__).read_text(encoding="utf-8"))
    leaves = set(cli._STATIC_IMPORTS_ALLOWED)
    offenders = []
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("houston.cli."):
            targets = [(node.module or "").split(".")[-1]]
        elif isinstance(node, ast.Import):
            targets = [a.name.split(".")[-1] for a in node.names
                       if a.name.startswith("houston.cli.")]
        offenders += [f"line {node.lineno}: {t}" for t in targets if t not in leaves]
    assert not offenders, (
        f"__init__.py imports a command module by name, which is a cycle: {offenders}")


def test_every_lazy_name_resolves_to_the_module_that_owns_it():
    """`_LAZY` is a hand-maintained map, so it is exactly the kind of registry that
    drifts. Every entry is resolved, and every command in the table is reachable."""
    for name in cli._LAZY:
        assert getattr(cli, name) is not None, name
    for module, _cmd, func in cli.REGISTRATION_ORDER:
        assert cli._LAZY.get(func) == module or func in dir(cli), func
