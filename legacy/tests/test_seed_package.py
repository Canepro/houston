"""`houston.seed/` as a package: the façade, the tiers, and what it re-exports.

The seeder is the one place that writes sample data through REST and then reads it back
against the plan it built. That readback is the part that catches a real defect, so it
gets its own module — and the layering that lets it is worth asserting rather than
assuming.
"""
from __future__ import annotations

import ast
import json
import pathlib

from houston import seed
from houston.seed import apply, check, kinds, plan, repairs, wording

TIERS = json.loads(
    (pathlib.Path(__file__).parent.parent / "tools" / "move-table.json").read_text(
        encoding="utf-8"))["modules"]["houston/seed.py"]["tiers"]
EXTRACTED = (kinds, repairs, wording, plan, apply, check)


def test_every_module_is_reachable_through_the_facade():
    for module in EXTRACTED:
        name = module.__name__.rsplit(".", 1)[-1]
        assert getattr(seed, name) is module, f"seed.{name} is not the module"
    assert sorted(TIERS) == sorted(m.__name__.rsplit(".", 1)[-1] for m in EXTRACTED)


def test_no_module_imports_a_higher_tier():
    """Read from the TREE, not from the plan: the two disagree exactly when an
    extraction was done differently from how it was planned."""
    aliases = {"seed_plan": "plan"}
    for module in EXTRACTED:
        own = TIERS[module.__name__.rsplit(".", 1)[-1]]
        tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            if (node.module or "") == "houston.seed":
                targets = [aliases.get(a.asname or a.name, a.name) for a in node.names]
            elif (node.module or "").startswith("houston.seed."):
                targets = [node.module.rsplit(".", 1)[-1]]
            else:
                continue
            for t in targets:
                assert t not in TIERS or TIERS[t] <= own, (
                    f"{module.__name__} (tier {own}) imports {t} (tier {TIERS[t]})")


def test_the_facade_still_re_exports_what_the_single_file_did():
    """`from houston.seed_profiles import PROFILES as PROFILES` is the idiom that says
    "this is part of my surface". Callers read `seed.PROFILES`, so the façade has to
    carry it or the re-export silently stops being one."""
    from houston import rcapi, seed_profiles

    assert seed.PROFILES is seed_profiles.PROFILES
    assert seed.Shape is seed_profiles.Shape
    # And the modules it imported, which the suite patches through the façade.
    assert seed.rcapi is rcapi


def test_the_readback_is_its_own_module_and_reads_what_apply_wrote():
    """`check` sits above `apply` on purpose: it exists to disagree with it.

    A readback that shared a module with the writer would be free to share its
    assumptions, and the whole value of the step is that it does not.
    """
    assert TIERS["check"] > TIERS["apply"]
    source = pathlib.Path(check.__file__).read_text(encoding="utf-8")
    assert "def readback" in source and "def verify" in source
