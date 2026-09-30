# legacy/ — the Python implementation, kept runnable, not shipped

This directory is the Python houston: the implementation that ran the tool from 2024
until the TypeScript port answered every command (Phase 8 of `.docs/migration/`, closed
2026-09-28). It was **moved here, not rewritten**: `git log --follow legacy/houston/<file>`
reaches every commit the file ever had, and those commit messages are prose naming the
defect each defensive branch exists for. That reasoning is the reason the tree is kept.
`// SOURCE: legacy/houston/<file>:<line>` comments in `src/` point back into it.

## What "not shipped" means

- `legacy/` is not in the npm package: `package.json`'s `files` allowlist names `dist/`,
  `data/` and `bin/` (and `libexec/` for as long as the dispatcher lives), and
  `yarn pack --dry-run` lists no `legacy/` path.
- No Python wheel is published from it any more. The `houston-py` console script it
  installs is the repository-local oracle, never a public binary.
- Nothing the shipped TypeScript runs depends on this directory. The one thing the two
  share is `data/` at the repository root, which the Python reads through the symlink
  `legacy/houston/data -> ../../data`.

## Running the oracle

From the repository root, with the checked-in virtualenv (never a bare `python`):

```bash
.venv/bin/pip install -e "legacy[dev,gui,browser]"   # editable install of this tree
.venv/bin/python -m playwright install chromium       # the browser tests' Chromium
.venv/bin/houston-py --version                        # sandbox: HOUSTON_HOME=$(mktemp -d)
.venv/bin/python -m pytest -q legacy/tests            # the suite (~7 min, no Docker)
.venv/bin/ruff check .                                # lint, F + E9 only
```

Every `houston-py` invocation writes start/end records to `$HOUSTON_HOME/logs/houston.log`,
so run it with a throwaway home unless you mean to write your own.

## Layout

`houston/` the package (`services/` the shared brain, `web/` the GUI routes, `cli/`, `perf/`,
`presets/`, `seed/`, `runner/`); `tests/` its suite, co-located with what each spec covers
(`tests/services/`, `tests/web/routes/`, `tests/browser/` ...), with the frozen help fixtures
under `tests/fixtures/`; `tools/` the oracle's own gates (`scc_check`, `structure_check`,
`seam_check`, `test_gate`, `wheel_smoke`, `capture_help`, `normalise_caps`, `move_table`,
`attribute_tests`, `phase6_order`) and their baselines, and the two generators that copy this
interpreter's Unicode tables and Rich's cell widths into the TypeScript build (`py_unicode`
writes `src/lib/py-unicode.ts`, `rich_cells` writes `src/cli/rich-cells.ts`; their specs under
`test/` fail when a copy and the installed Python disagree). All run as files from the
repository root:

```bash
.venv/bin/python legacy/tools/test_gate.py         # floor met, required layers present, then pytest
.venv/bin/python legacy/tools/scc_check.py         # no import cycles
.venv/bin/python legacy/tools/structure_check.py --ratchet
.venv/bin/python legacy/tools/seam_check.py
.venv/bin/python legacy/tools/py_unicode.py        # regenerate src/lib/py-unicode.ts
.venv/bin/python legacy/tools/rich_cells.py        # regenerate src/cli/rich-cells.ts
```

`pyproject.toml` and `setup.py` live here too, so `legacy/` is a complete Python project
and the repository root holds none.

## Two rules that still apply inside it

The frozen surfaces are frozen: the 41 help texts and `capabilities.baseline.json` under
`tests/fixtures/` are re-captured only with `tools/capture_help.py`, never by hand, and only
for a verified defect. And a change here is a change to an oracle: it is not released,
so the only reason to touch it is a test that proves the TypeScript port carried a
Python defect across.
