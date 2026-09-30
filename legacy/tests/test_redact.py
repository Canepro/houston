"""The shared redaction policy is a dependency-free service leaf."""

from __future__ import annotations

import ast
from pathlib import Path


def test_redaction_policy_is_shared_without_a_houston_dependency():
    from houston.services import eventlog, lifecycle, redact

    assert lifecycle.redact_env is redact.redact_env
    assert lifecycle.REDACTED == redact.REDACTED
    value = "mongodb://user:real-password@mongo:27017/rocketchat"
    assert eventlog._redact({"MONGO_URL": value}) == {
        "MONGO_URL": f"mongodb://user:{redact.REDACTED}@mongo:27017/rocketchat"}

    tree = ast.parse(Path(redact.__file__).read_text(encoding="utf-8"))
    imports = [node for node in ast.walk(tree)
               if isinstance(node, (ast.Import, ast.ImportFrom))]
    names = [node.module or "" for node in imports if isinstance(node, ast.ImportFrom)]
    names += [alias.name for node in imports if isinstance(node, ast.Import)
              for alias in node.names]
    assert not [name for name in names
                if name == "houston" or name.startswith("houston.")]
