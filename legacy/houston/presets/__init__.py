"""Load reproduction presets.

A preset bundles Rocket.Chat env vars and (later) backing services into a named
scenario. Built-ins are shipped in data/presets; a file of the same name in
~/.houston/presets overrides the built-in so users can tweak or add their own.
"""

from __future__ import annotations

import re
from importlib import resources

import yaml

from houston import config
from houston.presets.registry import Preset, builders, scenarios
from houston.presets.scenario import Scenario

#: `services.topology.DOCKER`. Spelled out rather than imported because presets is
#: the lower layer and must not depend on services; `test_preset_and_topology_agree`
#: asserts the two stay equal, which is the guarantee an import would have given.
_RUNTIME_DEFAULT = "docker"


def _parse(text: str, source: str) -> Preset:
    raw = yaml.safe_load(text) or {}
    # A LIST OR A SCALAR IS NOT A PRESET. `raw.get` on either is an AttributeError,
    # which is not a ReproError -- so one malformed file in the presets directory took
    # out `houston presets`, `/api/presets` and the create dialog, and made
    # `capabilities` report ZERO presets (it guards its own call with a bare
    # `except Exception`, so the failure became silence).
    if not isinstance(raw, dict):
        raise ValueError(f"preset {source} is a {type(raw).__name__}, not a mapping "
                         f"(a preset file is a YAML mapping with a 'name' key)")
    if not raw.get("name"):
        raise ValueError(f"preset {source} is missing a 'name' field")
    return Preset(
        name=raw["name"],
        description=raw.get("description", ""),
        env=raw.get("env") or {},
        services=raw.get("services") or {},
        rocketchat=raw.get("rocketchat") or {},
        depends_on=raw.get("depends_on") or [],
        requires_license=bool(raw.get("requires_license", False)),
        source=source,
        notes=[str(line) for line in raw.get("notes") or []],
        params_help=raw.get("params_help") or {},
        instances=int(raw.get("instances", 1) or 1),
        entry_service=raw.get("entry_service", "") or "",
        extra=raw.get("extra") or {},
        volumes=raw.get("volumes") or {},
        ports=[int(p) for p in raw.get("ports") or []],
        topology=raw.get("topology", "") or "",
    )


def _dynamic_builders() -> dict:
    """Load builders so each can register itself with the leaf registry."""
    return builders()


def scenario_names() -> tuple[str, ...]:
    """Return the built-in scenario names, derived from the shipped catalog."""
    dynamic = set(_dynamic_builders()) - {"multi-instance"}
    builtin_dir = resources.files("houston").joinpath("data", "presets")
    # No DEPLOYMENT_PRESETS exclusion: deployments are not presets here. PR #3
    # modelled "microservices" as a preset that implies Kubernetes; this branch
    # models it as a DEPLOYMENT under an explicit runtime, so there is nothing in
    # the preset catalogue to filter out.
    static = {
        entry.stem for entry in builtin_dir.iterdir()
        if entry.name.endswith(".yaml")
    }
    return tuple(sorted(dynamic | static))



def _scenario_definitions() -> dict[str, Scenario]:
    """Built-in scenario registry; intentionally not a public plugin registry."""
    return scenarios()


#: A preset name, and nothing that can be read as a path.
#:
#: `config.preset_dir() / f"{name}.yaml"` looks like it confines the lookup to the
#: presets directory and does not: pathlib's `/` DISCARDS the left operand when the
#: right is absolute, so `--preset /tmp/x` resolved to `/tmp/x.yaml` and the presets
#: directory was never consulted. No `..` and no existing presets dir required.
#:
#: That mattered because a preset is a container spec. Its `services:` is deep-merged
#: into the compose document (compose.py), so any readable YAML on the box became an
#: arbitrary image with arbitrary bind mounts, running as whoever runs houston --
#: reproduced with `volumes: ["/:/host:ro"]`. And `preset` is not in
#: `PRIVILEGED_CREATE_FIELDS`, so `POST /api/repros` is member+: on the shared server
#: this file's own README warns about, any member could hand the serve process a
#: container spec. Two lesser consequences travelled with it: naming another
#: workspace's `docker-compose.yml` (valid YAML with `name:` and `services:`) pulled
#: that workspace's Keycloak/MinIO/LDAP and their credentials into one of yours, and
#: the three distinguishable errors made the create dialog a filesystem oracle.
#:
#: The README already says "treat preset files as code — they can run arbitrary
#: containers and mount files". That is only safe because of the sentence before it,
#: "drop a YAML file in ~/.houston/presets/<name>.yaml", and that sentence was not
#: enforced anywhere. It is now, at the one place every reader goes through.
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _user_path(name: str):
    """The user-preset file for `name`, or refuse a name that is not a name.

    Validated here rather than at the call sites so `load`, `resolve` and
    `list_presets` all inherit it -- a check on two of the three is the shape this
    bug had in the first place.
    """
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ValueError(
            f"{name!r} is not a preset name (want lower-case letters, digits, '-' "
            f"and '_', starting with a letter or digit). A preset is a YAML file in "
            f"{config.preset_dir()}; it is named, never given as a path.")
    base = config.preset_dir()
    candidate = base / f"{name}.yaml"
    # Belt and braces: the regex already forbids '/', '\\' and '.', so this cannot
    # trigger today. It is here because the regex is one edit away from being
    # loosened, and the consequence of loosening it is arbitrary container specs.
    try:
        if candidate.resolve().parent != base.resolve():
            raise ValueError(f"preset {name!r} resolves outside {base}")
    except OSError:
        pass
    return candidate


def _load_non_scenario(name: str, params: dict) -> Preset:
    """Load a legacy dynamic or static preset without scenario dispatch."""
    builders = _dynamic_builders()
    if name in builders:
        return builders[name](params)

    builtin = resources.files("houston").joinpath("data", "presets", f"{name}.yaml")
    if not builtin.is_file():
        raise ValueError(f"unknown preset {name!r} (run `houston presets` to list)")
    return _parse(builtin.read_text(encoding="utf-8"), source="built-in")


def load(name: str, params: dict | None = None) -> Preset:
    """Return a preset by name.

    Precedence: a user file (~/.houston/presets/<name>.yaml) wins over everything
    — so users can override even a dynamic preset like `ldap`/`saml`. Otherwise a
    dynamic preset is built from `params`, else the built-in YAML is used.
    """
    params = params or {}

    user_path = _user_path(name)
    if user_path.exists():
        return _parse(user_path.read_text(encoding="utf-8"), source=str(user_path))

    scenario = _scenario_definitions().get(name)
    if scenario:
        return scenario.resolve(params, _RUNTIME_DEFAULT)
    return _load_non_scenario(name, params)


def resolve(name: str, deployment_type: str | None = None,
            params: dict | None = None) -> Preset:
    """Resolve one preset through its built-in scenario adapter when present.

    ``deployment_type`` is an internal seam. Leaving it unset preserves the
    current catalog behaviour and uses the preset's own declared topology. A
    user YAML override always wins and is never interpreted as a scenario.
    """
    params = params or {}
    user_path = _user_path(name)
    if user_path.exists():
        preset = _parse(user_path.read_text(encoding="utf-8"), source=str(user_path))
    else:
        scenario = _scenario_definitions().get(name)
        if scenario:
            target = deployment_type or _RUNTIME_DEFAULT
            return scenario.resolve(params, target)
        preset = _load_non_scenario(name, params)

    # Enforced only when the preset actually declares a requirement.
    if deployment_type and preset.topology and preset.topology != deployment_type:
        raise ValueError(
            f"preset {name!r} declares deployment type {preset.topology!r}, "
            f"not {deployment_type!r}")
    return preset


def list_presets() -> list[Preset]:
    """All available presets, user files shadowing built-ins, sorted by name."""
    seen: dict[str, Preset] = {}
    builtin_dir = resources.files("houston").joinpath("data", "presets")
    for entry in builtin_dir.iterdir():
        if entry.name.endswith(".yaml"):
            p = _parse(entry.read_text(encoding="utf-8"), source="built-in")
            seen[p.name] = p

    for name, build in _dynamic_builders().items():
        seen[name] = build({})  # default params, just for description/params_help

    user_dir = config.preset_dir()
    if user_dir.exists():
        for path in sorted(user_dir.glob("*.yaml")):
            # PER FILE, because one bad one used to take out the whole catalog: this
            # feeds `houston presets`, `/api/presets` and the create dialog, and
            # `capabilities` swallows the exception and reports ZERO presets. A file
            # somebody is halfway through writing must not do that. Reported the way
            # `backup.list_backups` reports an unreadable bundle -- named, not hidden.
            try:
                p = _parse(path.read_text(encoding="utf-8"), source=str(path))
            except (ValueError, OSError, yaml.YAMLError) as exc:
                seen[path.stem] = Preset(
                    name=path.stem,
                    description=f"UNREADABLE — {exc}",
                    error=str(exc))
                continue
            seen[p.name] = p

    return [seen[k] for k in sorted(seen)]
