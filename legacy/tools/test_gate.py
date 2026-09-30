#!/usr/bin/env python
"""Run pytest only after proving the recorded suite floor and optional layers exist."""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE = ROOT.parent / ".docs" / "migration" / "STATE.json"   # the repository root, above legacy/
COLLECTED = re.compile(r"(?P<count>\d+) tests? collected")
#: The two layers whose EXTRA hides its own absence -- without `[gui]` or `[browser]`
#: they skip themselves and report green while testing nothing. A directory now, since
#: 2b.16 co-located both, and a real floor rather than 1: the point is to catch a layer
#: that has quietly collapsed, and "at least one test" would not have.
REQUIRED_LAYERS = {
    "tests/web": 180,
    "tests/browser": 110,
}


def collected_count(output: str) -> int:
    matches = list(COLLECTED.finditer(output))
    if not matches:
        raise ValueError("pytest did not report a collected-test count")
    return int(matches[-1].group("count"))


def collect(*paths: str) -> int:
    env = dict(os.environ, HOUSTON_REQUIRE_EXTRAS="1", PYTHONDONTWRITEBYTECODE="1")
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
         *paths],
        cwd=ROOT, env=env, text=True, capture_output=True,
    )
    output = proc.stdout + proc.stderr
    if proc.returncode:
        sys.stderr.write(output)
        raise SystemExit(proc.returncode)
    return collected_count(output)


def junit_counts(xml_text: str) -> dict[str, int]:
    root = ET.fromstring(xml_text)
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    if root.tag != "testsuite" and root.attrib.get("tests") is not None:
        suites = [root]
    return {
        key: sum(int(s.attrib.get(key, "0")) for s in suites)
        for key in ("tests", "failures", "errors", "skipped")
    }


def result_problems(collected: int, floor: int, counts: dict[str, int]) -> list[str]:
    """Return every reason a superficially green pytest run is not the full gate."""
    problems = []
    if collected < floor:
        problems.append(f"collected {collected}, require at least {floor}")
    if counts["tests"] < floor:
        problems.append(f"executed {counts['tests']}, require at least {floor}")
    for key in ("failures", "errors", "skipped"):
        if counts[key]:
            problems.append(f"{key}={counts[key]}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect-only", action="store_true",
                        help="check collection and required layers without running the suite")
    args = parser.parse_args()

    state = json.loads(STATE.read_text(encoding="utf-8"))
    floor = int(state["baseline"]["currentSuiteCount"])
    actual = collect()
    if actual < floor:
        print(f"test floor breached: collected {actual}, require at least {floor}", file=sys.stderr)
        return 1
    for path, minimum in REQUIRED_LAYERS.items():
        layer_count = collect(path)
        if layer_count < minimum:
            print(f"required layer {path} collected {layer_count} tests", file=sys.stderr)
            return 1
    print(f"test collection gate passed: {actual} collected (floor {floor}); required layers present")
    if args.collect_only:
        return 0

    env = dict(os.environ, HOUSTON_REQUIRE_EXTRAS="1", PYTHONDONTWRITEBYTECODE="1")
    with tempfile.TemporaryDirectory(prefix="houston-test-gate-") as tmp:
        report = pathlib.Path(tmp) / "pytest.xml"
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
             f"--junitxml={report}"],
            cwd=ROOT, env=env,
        )
        if proc.returncode:
            return proc.returncode
        counts = junit_counts(report.read_text(encoding="utf-8"))
    problems = result_problems(actual, floor, counts)
    if problems:
        print(f"pytest result is not an all-executed pass: {', '.join(problems)}; {counts}",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
