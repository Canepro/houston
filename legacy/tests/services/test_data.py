"""`houston.services.data`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
import json
import pytest
import subprocess


def test_data_run_scale_validates(monkeypatch):
    from houston.services import data
    monkeypatch.setattr(data.lifecycle.naming, "resolve_name", lambda n: n)
    with pytest.raises(errors.ValidationError):
        data.run_scale("x", "garbage-spec")          # parse_scale rejects
    with pytest.raises(errors.ValidationError):
        data.run_scale("x", "")                       # nothing to do


def test_data_import_plan(monkeypatch, tmp_path):
    from houston.services import data
    monkeypatch.setattr(data.lifecycle.naming, "resolve_name", lambda n: n)
    dump = tmp_path / "s.json"
    dump.write_text(json.dumps([
        {"_id": "A", "value": "new", "packageValue": "old"},          # apply
        {"_id": "Site_Url", "value": "https://c", "packageValue": ""},  # denied
        {"_id": "SMTP_Password", "value": "XXXXXXXX", "packageValue": ""},  # redacted
    ]))
    plan = data.import_plan("x", str(dump))
    assert plan["counts"] == {"apply": 1, "redacted": 1, "denied": 1}
    assert plan["apply"][0]["id"] == "A"


def test_every_shipped_data_file_is_actually_in_the_repository():
    """Present on this machine is not the same as shipped.

    `.gitignore` had `docs/` unanchored, which matches a directory of that name at ANY
    depth -- so `houston/data/docs/` was silently excluded. The guide existed here,
    the package-data glob covered it, the test that checks the glob passed, and it
    would have been absent from every clone and from any wheel built from one. Nothing
    in the suite could see the difference, because the suite runs against the working
    tree.

    So this asks GIT, which is the only thing that knows what a clone would get.
    """
    from pathlib import Path

    from houston.services import eks

    root = Path(eks.__file__).parents[3]      # legacy/houston/services/eks.py -> the repository
    if not root.joinpath(".git").exists():
        pytest.skip("not a git checkout")

    data = root / "data"
    files = [p for p in data.rglob("*") if p.is_file()]
    assert files, "no package data found at all — the layout changed"
    raw = subprocess.run(["git", "ls-files", "-z", "--", str(data.relative_to(root))], cwd=root, capture_output=True, check=True).stdout
    tracked = {root / p.decode() for p in raw.split(b"\0") if p}
    missing = sorted(str(p.relative_to(root)) for p in files if p not in tracked)
    assert not missing, f"package data present but untracked (absent from clones/wheels): {missing}"


def test_data_scale_ok_error_mapping():
    from houston.services import data
    # non-zero exit / no JSON -> DockerError (infra); {error} payload -> ValidationError (user)
    with pytest.raises(errors.DockerError):
        data._scale_ok(1, "boom", "user prefill")
    with pytest.raises(errors.DockerError):
        data._scale_ok(0, "no json here", "user prefill")
    with pytest.raises(errors.ValidationError):
        data._scale_ok(0, '{"error": "room not found"}', "message prefill", hint="make it first")
    assert data._scale_ok(0, '{"inserted": 500}', "user prefill") == {"inserted": 500}
