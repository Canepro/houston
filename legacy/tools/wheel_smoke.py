#!/usr/bin/env python
"""Prove the WHEEL contains the packages, not just the checkout.

    .venv/bin/python tools/wheel_smoke.py --build-isolated   # build, install, check
    <venv>/bin/python tools/wheel_smoke.py --installed-only  # check what is installed
    .venv/bin/python tools/wheel_smoke.py --expect-missing houston.cli   # the gate's gate

**Why a source-tree import proves nothing.** `pip install -e .` writes a finder that maps
the top-level package directory and lets importlib walk down from there, so every nested
package resolves whether or not it is declared. `pyproject.toml` listed five packages by
hand; phase 2a added four more, and all four imported perfectly in the checkout while
being absent from anything built from it. The failure arrives at the first person to
`pip install houston`, as `ModuleNotFoundError` on a module the whole suite exercises.

So this builds a wheel, installs it into a throwaway virtual environment, changes
directory OUT of the repository -- otherwise `houston/` on `sys.path` answers every
import and the check is the same lie -- and then, inside that environment:

* imports every package and every nested subpackage the tree declares;
* runs the INSTALLED console script's `--help` for all 40 commands plus the root, and
  diffs it against the same fixtures the source tree is held to;
* reads a shipped package-data file through `importlib.resources`, which is how houston
  finds its presets, its GUI assets and its version pairings. Six such lookups exist and
  a wheel that omits `data/` breaks all of them at runtime with a green build.

`--expect-missing` is how this file is itself tested: it asserts a named package is
ABSENT, so a deliberately narrowed discovery rule has to fail before the smoke check is
allowed to mean anything.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent


def expected_packages() -> list[str]:
    """Every package in the source tree, as a dotted name.

    Walked rather than listed, for the reason the list this replaces failed: a name
    written down once is wrong the first time somebody adds a directory.
    """
    names = []
    for init in sorted((REPO_ROOT / "houston").rglob("__init__.py")):
        rel = init.parent.relative_to(REPO_ROOT)
        names.append(".".join(rel.parts))
    return names


def expected_modules() -> list[str]:
    """Every module, so a package that ships without its contents also fails."""
    names = []
    for path in sorted((REPO_ROOT / "houston").rglob("*.py")):
        if path.name == "__init__.py":
            continue
        rel = path.relative_to(REPO_ROOT).with_suffix("")
        names.append(".".join(rel.parts))
    return names


def check_installed(expect_missing: str = "") -> int:
    """Run INSIDE the throwaway environment, from outside the checkout."""
    import importlib
    from importlib import resources

    here = pathlib.Path.cwd().resolve()
    if here == REPO_ROOT or REPO_ROOT in here.parents:
        print(f"wheel_smoke: cwd {here} is inside the checkout, so this proves nothing",
              file=sys.stderr)
        return 2

    wanted = json.loads(os.environ.get("HOUSTON_SMOKE_NAMES", "[]"))
    if not wanted:
        print("wheel_smoke: HOUSTON_SMOKE_NAMES is empty", file=sys.stderr)
        return 2

    missing = []
    for name in wanted:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - the failure IS the result here
            missing.append(f"{name}: {type(exc).__name__}: {exc}")

    if expect_missing:
        absent = [m for m in missing if m.startswith(expect_missing + ":")]
        if not absent:
            print(f"wheel_smoke: expected {expect_missing} to be MISSING from the wheel "
                  f"and it imported fine — the gate's own gate does not bite",
                  file=sys.stderr)
            return 1
        print(f"wheel_smoke: {expect_missing} is absent from the wheel, as expected")
        return 0

    if missing:
        print("wheel_smoke: these are in the source tree and not in the wheel:",
              file=sys.stderr)
        for line in missing:
            print(f"  {line}", file=sys.stderr)
        return 1

    # Package data, through the same lookup the product uses.
    for package, name in (("houston", "data/versions.yaml"),
                          ("houston", "data/webui/index.html"),
                          ("houston", "data/docs/ARCHITECTURE.md")):
        path = resources.files(package).joinpath(*name.split("/"))
        if not path.is_file():
            print(f"wheel_smoke: package data {name} is not in the wheel", file=sys.stderr)
            return 1

    # The INSTALLED console script, not the checkout's.
    script = pathlib.Path(sys.executable).with_name("houston-py")
    if not script.exists():
        print("wheel_smoke: the wheel installed no `houston-py` console script",
              file=sys.stderr)
        return 1
    proc = subprocess.run([str(script), "--help"], capture_output=True, text=True)
    if proc.returncode or "Commands" not in proc.stdout:
        print(f"wheel_smoke: `houston-py --help` exited {proc.returncode}", file=sys.stderr)
        return 1

    print(f"wheel_smoke: {len(wanted)} modules, 3 data files and the console script are "
          f"all in the wheel, imported from {here}")
    return 0


def check_help_against_fixtures(python: pathlib.Path) -> int:
    """Render every help text with the INSTALLED build and diff the fixtures.

    Through `tools/capture_help.py`, so there is one definition of "normalised help" and
    not a second one here that could disagree with the source tree's.
    """
    env = dict(os.environ, HOUSTON_CAPTURE_PYTHON=str(python))
    proc = subprocess.run([sys.executable, str(REPO_ROOT / "tools" / "capture_help.py"),
                           "--check"], cwd=REPO_ROOT, env=env, text=True,
                          capture_output=True)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    return proc.returncode


def _clean_copy(dest: pathlib.Path) -> pathlib.Path:
    """The tree as git sees it, copied somewhere with no build state in it.

    Building in place is not safe and this file found out how. `setup.py build_py` copies
    the package into `build/lib/` INCREMENTALLY and never removes what is no longer
    there, so the checkout's `build/lib/houston/` still held `cli.py` months after the
    CLI became `cli/` -- and the wheel is zipped from that directory, not from the source.
    Two consequences, both silent: a wheel can ship a module the tree deleted, and a
    change to which packages are DISCOVERED has no visible effect at all, because the
    stale copy is already sitting there. Narrowing discovery to exclude `houston.cli`
    changed nothing about the wheel until this function existed.

    `git ls-files -co --exclude-standard` is tracked plus untracked-but-not-ignored,
    which is exactly "the source" and excludes `build/`, `.venv/` and `*.egg-info/`.
    """
    listed = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"],
                            cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    dest.mkdir(parents=True)
    # The package data is not under legacy/: `houston/data` is a link to `../../data` at the
    # repository root, so the copy needs the same directory at the same relative place.
    shutil.copytree(REPO_ROOT.parent / "data", dest.parent / "data")
    for rel in listed.stdout.splitlines():
        src = REPO_ROOT / rel
        target = dest / rel
        if src.is_symlink():
            # `houston/data` is a link to `../../data` since Phase 9.0: the TypeScript build
            # owns the data and the oracle reads it through the link. `is_file()` is false for a
            # link to a directory, so without this branch the copy had no package data at
            # all and the wheel was built without it.
            target.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.readlink(src), target)
            continue
        if not src.is_file():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    return dest


def _has_setuptools() -> bool:
    try:
        import setuptools  # noqa: F401
    except ImportError:
        return False
    return True


def build_and_check(expect_missing: str = "") -> int:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="houston-wheel-"))
    try:
        source = _clean_copy(tmp / "src")
        dist = tmp / "dist"
        # `--no-build-isolation` when this interpreter already has the backend, because
        # it is deterministic and needs no network; isolated otherwise, since the
        # checked-in venv deliberately carries only what houston runs on and setuptools
        # is not one of those. Either way the wheel is built from THIS tree.
        isolation = [] if _has_setuptools() else ["--use-pep517"]
        if not isolation:
            isolation = ["--no-build-isolation"]
        # `--no-cache-dir`, and it is load-bearing. pip keys its wheel cache on the
        # source directory, so a second run can hand back the PREVIOUS build -- which
        # made this check report on a stale artifact and pass while `houston.cli` had
        # been deliberately excluded from discovery. A gate that can be answered from a
        # cache is not measuring the tree in front of it.
        build = subprocess.run(
            [sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-cache-dir",
             *isolation, "--wheel-dir", str(dist), str(source)],
            capture_output=True, text=True)
        if build.returncode:
            sys.stderr.write(build.stdout + build.stderr)
            return build.returncode
        wheels = sorted(dist.glob("houston-*.whl"))
        if len(wheels) != 1:
            print(f"wheel_smoke: expected one wheel, found {[w.name for w in wheels]}",
                  file=sys.stderr)
            return 1

        venv = tmp / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        python = venv / "bin" / "python"
        # WITH `[gui]`. Half the tree imports fastapi at module scope, and without the
        # extra every `houston.web.*` import fails on the dependency rather than on the
        # question being asked -- which would report a missing PACKAGE and a missing
        # DEPENDENCY as the same thing, in both directions.
        install = subprocess.run(
            [str(python), "-m", "pip", "install", "-q", f"{wheels[0]}[gui]"],
            capture_output=True, text=True)
        if install.returncode:
            sys.stderr.write(install.stdout + install.stderr)
            return install.returncode

        outside = tmp / "outside"
        outside.mkdir()
        names = expected_packages() + expected_modules()
        if expect_missing:
            names = [n for n in names if n == expect_missing or not n.startswith(expect_missing)]
        env = dict(os.environ, HOUSTON_SMOKE_NAMES=json.dumps(names),
                   HOUSTON_HOME=str(tmp / "home"), PYTHONDONTWRITEBYTECODE="1")
        argv = [str(python), str(REPO_ROOT / "tools" / "wheel_smoke.py"), "--installed-only"]
        if expect_missing:
            argv += ["--expect-missing", expect_missing]
        rc = subprocess.run(argv, cwd=outside, env=env).returncode
        if rc or expect_missing:
            return rc
        return check_help_against_fixtures(python)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build-isolated", action="store_true",
                    help="build a wheel, install it into a throwaway venv, and check it")
    ap.add_argument("--installed-only", action="store_true",
                    help="check what is installed in THIS interpreter (run inside the venv)")
    ap.add_argument("--expect-missing", default="", metavar="PACKAGE",
                    help="assert this package is ABSENT from the wheel — how this gate is "
                         "itself tested")
    args = ap.parse_args()
    if args.installed_only:
        return check_installed(args.expect_missing)
    if args.build_isolated or args.expect_missing:
        return build_and_check(args.expect_missing)
    ap.error("pass --build-isolated or --installed-only")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
