"""Helpers the specs split out of `tests/test_core.py` share, lifted whole.

Imported by name, the way these tests already import from `conftest`. The ones
that are CALLED need nothing more than that; a fixture, which is REQUESTED by
parameter name, is discovered in whatever module namespace it is imported into,
so it travels the same way and carries a `# noqa` where nothing reads the name.
Phase 02b requires the root `conftest.py` to stay as it is.
"""
from __future__ import annotations
from houston import compose
from houston import presets
from houston import seed
from houston import versions
import json


# --- version resolution (the LIVE lookup) -------------------------------------
# Everything above passes offline=True, so this path had no test at all -- which is
# how RC 7.13.x shipped unbootable. releases.rocket.chat is not consistent about the
# shape of compatibleMongoVersions, and the value was used verbatim as a docker tag.


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


def _live(monkeypatch, compatible, version="7.13.6"):
    """Resolve `version` with the API stubbed to answer `compatible`."""
    monkeypatch.setattr(versions.requests, "get",
                        lambda *a, **k: _FakeResp({"compatibleMongoVersions": compatible}))
    return versions.resolve(version)


# --- compose building ---------------------------------------------------------


def _spec(version: str, preset_name: str = "default", params: dict | None = None,
          monitoring_flag: bool = False):
    r = versions.resolve(version, offline=True)
    pre = presets.load(preset_name, params or {})
    return compose.Spec.from_resolved(
        r, project_name="houston-t", root_url="http://localhost:3000",
        host_port=3000, reg_token=None, preset=pre, monitoring=monitoring_flag,
    )


# --- config import (support-dump settings.json) -------------------------------


def _dump(tmp_path, items):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(items))
    return p


def _fake_run(calls, returncode=0, stdout=""):
    """subprocess.run stub that records the argv it was handed."""
    import types

    def run(cmd, **_kw):
        calls.append(cmd)
        return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")
    return run


def _spec_for(pre):
    """A Spec around a hand-built Preset (the shared _spec() takes a preset NAME)."""
    r = versions.resolve("8.4.1", offline=True)
    return compose.Spec.from_resolved(
        r, project_name="houston-t", root_url="http://localhost:3000",
        host_port=3000, reg_token=None, preset=pre)


# --- HTTPS add-on (--https) ---------------------------------------------------


def _tls_spec(**kw):
    from houston import tls
    base = dict(mode=tls.MODE_LOCAL, host="x.houston.localhost", port=8443)
    base.update(kw)
    return tls.TlsSpec(**base)


# --- the seed readback --------------------------------------------------------

def _facts(plan, **over):
    """Readback facts for a plan where everything is exactly as asked."""
    rooms = []
    for spec in plan.rooms:
        rooms.append(seed.RoomFacts(spec=spec, found=True, rid=f"r-{spec.name}",
                                    messages=spec.total_messages, replies=spec.replies,
                                    reacted=spec.reacted, threads=len(spec.threads)))
    out = {"rooms": rooms, "planned_users": [seed.username(i) for i in range(plan.users)],
           "users_unreadable": ""}
    out["users_found"] = list(out["planned_users"])
    out.update(over)
    return out


#: Where `config.ADMIN_PASSWORD` is the CORRECT answer. Each is either the constant
#: itself or the one fallback applied where a caller supplied no password:
#:
#:   runner.py       `Metadata.admin_pass`, the fallback everything else reads
#:   compose.py      the same, applied where the admin is actually provisioned
#:   services/k8s.py the same, for the chart's extraEnv
#:   seed.py         the same, for a caller that passes no password
#:   configimport.py the same
#:   rcapi.py        the `login()` default, for a loopback caller
#:   perf/k6.py      the `run()` default, same reason
#: Keyed on the FILE, so a split has to carry each entry to the module that still reads
#: the constant -- which is the point: an allow-list that follows a rename automatically
#: is an allow-list that stops being reviewed -- which the staleness test below enforces
#: by refusing an entry nothing uses, including one added in anticipation.
#: The one Kubernetes reader is `values_for`, and step 2b.10 moved it to `chart.py`, so
#: this entry moved with it -- which is the point of keying on the file.
_SHARED_PASSWORD_OK = {
    "runner/record.py", "compose.py", "seed/apply.py", "configimport.py", "rcapi.py",
    "services/k8s/chart.py", "perf/k6.py",
}


def _shared_password_readers() -> list[str]:
    """Every `config.ADMIN_PASSWORD` ATTRIBUTE ACCESS in the package, parsed.

    Parsed rather than grepped for the reason `test_every_engine_heavy_job_kind_lands
    _in_a_pool` gives: a grep counts the constant's own docstring, and a walk that
    fires on prose is one somebody switches off.
    """
    import ast
    import pathlib

    from houston import config as cfgmod

    root = pathlib.Path(cfgmod.__file__).parent
    found = []
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        if rel == "config.py":                       # the definition itself
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Attribute) and node.attr == "ADMIN_PASSWORD"
                    and isinstance(node.value, ast.Name) and node.value.id == "config"):
                found.append(f"{rel}:{node.lineno}")
    return found
