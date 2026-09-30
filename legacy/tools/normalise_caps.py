#!/usr/bin/env python
"""Strip everything from `capabilities` that describes THIS MACHINE rather than the contract.

Read the envelope on stdin, write a canonical form on stdout::

    houston capabilities | python tools/normalise_caps.py

`capabilities` is the published CLI contract, so freezing it as a fixture is how a
later phase notices that moving 40 command paths into 13 modules changed what callers can
see. But the raw document cannot be a fixture: five kinds of value in it are true only
of the box and the moment that produced it, and a fixture containing any of them can
never diff empty anywhere else. Phase 0's exit gate is specifically "diffs empty **on a
second machine**", so each one is replaced with a placeholder rather than deleted -- the
KEY is part of the contract even when the value is not, and deleting it would hide the
day a key disappears.

What is replaced, and why each one would otherwise break the gate:

* ``generated_at`` -- an ISO timestamp, different on every single run.
* ``houston_version`` -- this moves with every release, at the top level and again
  inside ``data``. A fixture pinned to 1.0.0 fails the day the version bumps, which
  would train whoever sees it to re-capture the fixture without reading the diff.
* ``rc_repro_version`` -- **gone from the envelope since step 0.12**, and still handled
  here on purpose. Normalising a value never hid the key, which is why deleting it
  showed up as a fixture diff exactly as this docstring predicted. The handling stays
  as a guard: if the key is ever reintroduced, it is normalised rather than pinning the
  fixture to a release, and the diff still announces its return.
* Anything under ``skill`` -- ``version``, ``status`` and ``current`` report whether the
  agent skill file installed on this machine matches this build. On a box where nothing
  is installed, ``status`` is "absent" and ``current`` is false; here they are "current"
  and true. That is machine state, not contract.
* Absolute paths -- ``skill.hosts[*].path`` names ``$HOME`` and the checkout directory.
  Collapsed to ``$REPO`` and ``$HOME``, repository root FIRST because the checkout
  usually lives underneath the home directory and collapsing the shorter prefix first
  would leave the directory name behind.

The collapse is applied to every string in the document, not only to the keys known to
hold a path today. A new field carrying a path would otherwise reintroduce the failure
this script exists to prevent, and it would do it silently on somebody else's machine.

Output is sorted-key JSON with a trailing newline, so `diff` output is about content
rather than about key ordering or whitespace.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

VERSION_KEYS = ("houston_version", "rc_repro_version")
SKILL_STATE_KEYS = ("version", "status", "current")

PLACEHOLDER_TIME = "<generated_at>"
PLACEHOLDER_VERSION = "<version>"
PLACEHOLDER_STATE = "<install state>"

# This file lives in `legacy/tools/`, so the repository root is three levels up. Derived rather
# than passed in, because a wrong root here fails open: the path stays absolute and the
# fixture silently pins itself to one machine.
REPO_ROOT = str(pathlib.Path(__file__).resolve().parents[2])   # legacy/tools/ -> legacy/ -> the repository


def collapse_paths(text: str) -> str:
    """Replace machine-specific prefixes with stable tokens. Longest prefix first."""
    home = os.path.expanduser("~")
    for prefix, token in sorted(((REPO_ROOT, "$REPO"), (home, "$HOME")),
                                key=lambda pair: len(pair[0]), reverse=True):
        if prefix and prefix != "/":
            text = text.replace(prefix, token)
    return text


def normalise(node, *, in_skill: bool = False):
    """Walk the document, replacing machine-specific values in place of their keys."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key == "generated_at":
                out[key] = PLACEHOLDER_TIME
            elif key in VERSION_KEYS:
                out[key] = PLACEHOLDER_VERSION
            elif in_skill and key in SKILL_STATE_KEYS:
                out[key] = PLACEHOLDER_VERSION if key == "version" else PLACEHOLDER_STATE
            else:
                out[key] = normalise(value, in_skill=in_skill or key == "skill")
        return out
    if isinstance(node, list):
        return [normalise(item, in_skill=in_skill) for item in node]
    if isinstance(node, str):
        return collapse_paths(node)
    return node


def render(raw: str) -> str:
    """Normalise a raw envelope into the exact text the fixture holds.

    The test that diffs the fixture calls THIS, not a copy of the two lines below, so
    the serialisation cannot drift between what captures the fixture and what checks it.
    """
    return json.dumps(normalise(json.loads(raw)), indent=2, sort_keys=True) + "\n"


def main() -> int:
    raw = sys.stdin.read()
    try:
        out = render(raw)
    except json.JSONDecodeError as exc:
        # Loud, because the usual cause is prose on stdout -- which is itself a contract
        # violation worth failing on rather than working around.
        print(f"tools/normalise_caps.py: stdin is not JSON ({exc}). "
              f"`capabilities` must put JSON and nothing else on stdout.", file=sys.stderr)
        return 2
    sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
