"""Build a docker-compose document for one repro.

Built as a Python dict (then dumped to YAML) rather than a fixed template, so
presets can deep-merge extra services / env / RC patches into it.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import yaml

from houston import config
from houston.errors import ValidationError
from houston.presets import Preset

if TYPE_CHECKING:                      # only for the Spec.tls annotation
    from houston.tls import TlsSpec


@dataclass
class Spec:
    project_name: str
    rc_image: str
    rc_tag: str
    mongo_tag: str
    mongo_flavor: str        # "bitnami-legacy" | "official"
    mongo_shell: str         # used only by the official flavor's init container
    oplog: bool
    root_url: str
    host_port: int
    reg_token: str | None
    preset: Preset
    monitoring: bool = False   # --monitor: add Prometheus + Grafana
    # --https: terminate TLS in a Traefik sidecar. None = plain http, as before.
    tls: "TlsSpec | None" = None
    # `up --env K=V` / `houston env --set`. Applied to every rocketchat service,
    # last, so it beats the preset. A None value removes the key.
    env_overrides: dict = field(default_factory=dict)
    container_port: int = config.RC_CONTAINER_PORT
    # Host interface published ports bind to (the official rocketchat-compose
    # BIND_IP pattern). Loopback by default: repros run weak fixed credentials,
    # so they must not be reachable from the local network unless asked
    # (`up --bind 0.0.0.0` / HOUSTON_BIND_HOST).
    bind_host: str = config.DEFAULT_BIND_HOST
    #: The workspace's Rocket.Chat admin password. Empty means the shared loopback
    #: `config.ADMIN_PASSWORD` -- see `runner.Metadata.admin_pass`, which is the
    #: same fallback read from the other side. It is a SPEC field because the
    #: compose document is what actually provisions the admin, so a password stored
    #: in repro.json and not put here would be a record of a login that does not work.
    admin_password: str = ""

    @classmethod
    def from_resolved(cls, resolved, *, project_name: str, root_url: str,
                      host_port: int, reg_token: str | None, preset: Preset,
                      bind_host: str = config.DEFAULT_BIND_HOST,
                      monitoring: bool = False,
                      tls: "TlsSpec | None" = None,
                      env_overrides: dict | None = None) -> "Spec":
        """Build a Spec from a versions.Resolved plus the launch-time choices."""
        return cls(
            project_name=project_name,
            rc_image=resolved.rc_image,
            rc_tag=resolved.rc_version,
            mongo_tag=resolved.mongo_tag,
            mongo_flavor=resolved.mongo_flavor,
            mongo_shell=resolved.mongo_shell,
            oplog=resolved.oplog,
            root_url=root_url,
            host_port=host_port,
            reg_token=reg_token,
            preset=preset,
            bind_host=bind_host,
            monitoring=monitoring,
            tls=tls,
            env_overrides=dict(env_overrides or {}),
        )


def rc_service_names(instances: int) -> list[str]:
    """The rocketchat service name(s) in the compose doc: one 'rocketchat', or
    'rocketchat-1..N' for a multi-instance repro. Used for Prometheus targets."""
    n = max(1, instances or 1)
    return ["rocketchat"] if n == 1 else [f"rocketchat-{i}" for i in range(1, n + 1)]


def _deep_merge(base: dict, patch: dict) -> dict:
    """Recursively merge patch into base (patch wins), returning base."""
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _rc_environment(spec: Spec) -> dict:
    env: dict[str, str] = {
        "ROOT_URL": spec.root_url,
        "PORT": str(spec.container_port),
        "DEPLOY_METHOD": "docker",
        "DEPLOY_PLATFORM": "compose",
        "MONGO_URL": config.MONGO_URL,
        "ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS": "true",
        # Every repro should be usable out of the box: skip the setup wizard
        # (houston also finalizes it over the API on `ready`) and auto-provision
        # the first admin. Presets only add their scenario-specific settings.
        "OVERWRITE_SETTING_Show_Setup_Wizard": "completed",
        # NO `INITIAL_USER`, and its absence is measured rather than assumed. It used
        # to be here as "yes", and Rocket.Chat parses this one as JSON: every boot of
        # every workspace logged `Error processing environment variable INITIAL_USER
        # SyntaxError: Unexpected token 'y', "yes" is not valid JSON`, on both
        # runtimes, forever -- noise in exactly the artefact a support engineer reads
        # to find the customer's real problem.
        #
        # `true` is what RC's docs use and it is WORSE, which is why this was booted
        # rather than edited: RC parses it, finds no `_id` on it, and logs `No _id
        # provided; Ignoring environment variable INITIAL_USER`. One warning traded
        # for another that says the variable is being ignored.
        #
        # Removing it entirely is what works, because the admin never came from it --
        # ADMIN_USERNAME/ADMIN_PASS/ADMIN_EMAIL below do that. Verified on a fresh
        # 8.5.1 database with the variable absent: zero INITIAL_USER lines in the log,
        # login succeeds, /api/v1/me reports roles ['admin'], and Show_Setup_Wizard
        # reads `completed`. Checked on 6.5.3 too, the oldest series booted for this,
        # whose log still prints "Inserting admin user:".
        "ADMIN_USERNAME": config.ADMIN_USERNAME,
        "ADMIN_NAME": config.ADMIN_NAME,
        "ADMIN_EMAIL": config.ADMIN_EMAIL,
        "ADMIN_PASS": spec.admin_password or config.ADMIN_PASSWORD,
    }
    if spec.oplog:  # RC < 8 only; deprecated in 8.x
        env["MONGO_OPLOG_URL"] = config.MONGO_OPLOG_URL
    if spec.reg_token:
        env["REG_TOKEN"] = spec.reg_token
    # Preset env (OVERWRITE_SETTING_* etc.) wins over base defaults.
    env.update({k: str(v) for k, v in spec.preset.env.items()})
    # Explicit user overrides win over everything, including the base keys: this is
    # a reproduction tool, so pointing MONGO_URL or ROOT_URL somewhere odd is a
    # legitimate thing to want. `houston env` warns about the ones that break it.
    # A None value means "remove this key entirely", which is how you unset a base
    # or preset default rather than merely blanking it.
    for k, v in (spec.env_overrides or {}).items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = str(v)
    return env


# mongod asks for 64000 open files and warns on every boot that 1024 is too low
# ("Soft rlimits for open file descriptors too low"). Docker's default soft limit
# IS 1024, and normal Rocket.Chat traffic survives it -- but building many
# collections and indexes at once does not: a `houston restore` hit EMFILE inside
# WiredTiger, which panics and aborts the whole mongod rather than failing the one
# operation. The container's hard limit is far higher, so raising the soft limit
# costs nothing.
_MONGO_ULIMITS = {"nofile": {"soft": 64000, "hard": 64000}}


def _mongo_service_bitnami(spec: Spec) -> dict:
    # Bitnami auto-initiates the replica set via REPLICA_SET_MODE=primary,
    # so no separate init container is needed.
    return {
        "mongodb": {
            "image": f"docker.io/bitnamilegacy/mongodb:{spec.mongo_tag}",
            "restart": "always",
            "ulimits": dict(_MONGO_ULIMITS),
            # Bitnami MongoDB images are published for amd64 only; pin the
            # platform so they run (under emulation) on Apple Silicon too.
            "platform": "linux/amd64",
            "volumes": ["mongodb_data:/bitnami/mongodb"],
            "environment": {
                "MONGODB_REPLICA_SET_MODE": "primary",
                "MONGODB_REPLICA_SET_NAME": "rs0",
                "MONGODB_PORT_NUMBER": "27017",
                "MONGODB_INITIAL_PRIMARY_HOST": "mongodb",
                "MONGODB_INITIAL_PRIMARY_PORT_NUMBER": "27017",
                "MONGODB_ADVERTISED_HOSTNAME": "mongodb",
                "MONGODB_ENABLE_JOURNAL": "true",
                "ALLOW_EMPTY_PASSWORD": "yes",
            },
        }
    }


def _mongo_service_official(spec: Spec) -> dict:
    # Mirrors the official RocketChat/rocketchat-compose: MongoDB Inc's
    # community-server image (runs as uid 1001), so a fix-permission container
    # chowns the data dir first, then a one-shot container initiates the replica
    # set. `directConnection=true` lets mongosh reach the node before rs.initiate.
    image = f"docker.io/mongodb/mongodb-community-server:{spec.mongo_tag}-ubi8"
    shell = spec.mongo_shell  # mongosh for Mongo >= 5
    uri = "mongodb://mongodb:27017/?directConnection=true"
    initiate = (
        "try { rs.status() } catch (e) { rs.initiate({ _id: 'rs0', "
        "members: [{ _id: 0, host: 'mongodb:27017' }] }) }"
    )
    return {
        "mongodb-fix-permission": {
            "image": image,
            "user": "0",
            "restart": "on-failure",
            "volumes": ["mongodb_data:/data/db:rw"],
            "entrypoint": ["sh", "-c", "chown -R 1001 /data/db"],
        },
        "mongodb": {
            "image": image,
            "user": "1001",
            "restart": "always",
            "ulimits": dict(_MONGO_ULIMITS),
            "depends_on": {"mongodb-fix-permission": {"condition": "service_completed_successfully"}},
            "volumes": ["mongodb_data:/data/db:rw"],
            "entrypoint": ["mongod", "--replSet", "rs0", "--bind_ip_all"],
            "environment": {"ALLOW_EMPTY_PASSWORD": "yes"},
            "healthcheck": {
                "test": ["CMD", shell, uri, "--eval", "db.adminCommand('ping')"],
                "interval": "10s",
                "timeout": "10s",
                "retries": 30,
                "start_period": "20s",
            },
        },
        "mongo-init": {
            "image": image,
            "restart": "no",
            "depends_on": {"mongodb": {"condition": "service_healthy"}},
            "entrypoint": [shell, uri, "--eval", initiate],
        },
    }


# Healthcheck for a Rocket.Chat instance. Uses `node` (always in the RC image)
# to hit /api/info, so we don't depend on curl/wget being present.
_RC_HEALTHCHECK = {
    "test": [
        "CMD", "node", "-e",
        "require('http').get('http://localhost:3000/api/info',"
        "r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))",
    ],
    "interval": "10s",
    "timeout": "5s",
    "retries": 30,
    "start_period": "60s",
}


def _as_condition_map(deps) -> dict:
    """Normalise a depends_on (plain list or condition-map) to a condition-map."""
    if isinstance(deps, dict):
        return dict(deps)
    return {d: {"condition": "service_started"} for d in (deps or [])}


def _instance_services(base: dict, n: int, host_port: int,
                       container_port: int = config.RC_CONTAINER_PORT) -> dict:
    """Clone the rocketchat service into N instances (rocketchat-1..N).

    Instances coordinate over NATS (the moleculer transporter), matching the
    official RocketChat/rocketchat-compose. INSTANCE_IP is intentionally left
    unset — the legacy DDP-mesh address isn't used once NATS is the transporter.

    The load balancer owns the workspace port (host_port); each instance is ALSO
    published directly on host_port+i so you can open a specific instance in the
    browser (e.g. to post on one and watch it arrive on another). Traefik reaches
    them over the compose network by service name regardless.

    Cold start is serialised: only rocketchat-1 boots against the empty database
    (running migrations and seeding settings); rocketchat-2..N wait for it to be
    healthy first, so they never race it to insert the same records — which on a
    fresh DB otherwise crashes an instance with E11000 duplicate-key errors.
    """
    out: dict = {}
    for i in range(1, n + 1):
        name = f"rocketchat-{i}"
        inst = copy.deepcopy(base)
        inst["ports"] = [f"{host_port + i}:{container_port}"]   # direct access
        inst["environment"]["TRANSPORTER"] = "monolith+nats://nats:4222"
        inst["healthcheck"] = copy.deepcopy(_RC_HEALTHCHECK)
        if i > 1:
            deps = _as_condition_map(inst.get("depends_on"))
            deps["rocketchat-1"] = {"condition": "service_healthy"}
            inst["depends_on"] = deps
        out[name] = inst
    return out


def _add_depends(svc: dict, extra: list[str]) -> None:
    """Add each name in `extra` to a service's depends_on (list or condition-dict)."""
    deps = svc.get("depends_on")
    for dep in extra:
        if isinstance(deps, list):
            if dep not in deps:
                deps.append(dep)
        elif isinstance(deps, dict):
            deps.setdefault(dep, {"condition": "service_started"})


def _attach_monitoring(doc, rc_services, spec):
    """The Prometheus/Grafana add-on, wired to every Rocket.Chat instance."""
    # --- optional monitoring add-on (Prometheus + Grafana) ---
    if spec.monitoring:
        from houston import monitoring
        _deep_merge(doc["services"], monitoring.services())   # bare ports; bound below
        doc["volumes"].update(monitoring.volumes())
        for svc in rc_services.values():
            svc["environment"][monitoring.RC_METRICS_ENV] = "true"


def _publish_through_entry_service(doc, rc_services, spec):
    """Give the published host port to the preset's front end, and to nothing else."""
    # A preset can hand the published host port to a front-end service (a load
    # balancer) instead of rocketchat — the port isn't known until `up`, so it's
    # injected here rather than in the preset.
    entry = spec.preset.entry_service
    if entry:
        if entry not in doc["services"]:
            # Silently skipping meant NOTHING published the host port: the repro
            # booted and was unreachable at its own advertised root_url.
            raise ValueError(
                f"preset {spec.preset.name!r} sets entry_service {entry!r}, which is not "
                f"one of its services ({', '.join(sorted(doc['services']))})")
        doc["services"][entry]["ports"] = [f"{spec.host_port}:80"]
        # The front-end owns the published port now. Leaving the same host port on
        # the RC service too binds it twice and `up` fails with "port is already
        # allocated" — which a single-instance preset setting entry_service (a
        # custom one; the built-in multi-instance forces instances >= 2) would hit
        # every time. Drop only the colliding mapping, so multi-instance keeps its
        # direct per-instance ports on host_port+i.
        for svc_name, svc in rc_services.items():
            if svc_name == entry:
                continue
            kept = [p for p in svc.get("ports", [])
                    if str(p).split(":")[0] != str(spec.host_port)]
            if kept:
                svc["ports"] = kept
            else:
                svc.pop("ports", None)


def _rocketchat_services(n, official, spec):
    """The Rocket.Chat service, or N clones of it behind a load balancer."""
    rocketchat: dict = {
        "image": f"{spec.rc_image}:{spec.rc_tag}",
        "restart": "always",
        "environment": _rc_environment(spec),
        "ports": [f"{spec.host_port}:{spec.container_port}"],
        # The same probe the cloned instances have always had. Without it Docker
        # reports no health for this service, and `detail()` then falls back to the
        # container STATE -- which is "running" from the moment the process starts,
        # minutes before Rocket.Chat serves anything. The panel said
        # "Health: running" on a workspace whose /api/info was refusing the
        # connection outright, which is the one question that field exists to
        # answer.
        #
        # Informational only: nothing declares depends_on service_healthy against
        # the single-instance service, and `_up` does not pass --wait, so this
        # changes what is REPORTED and not what anything waits for.
        "healthcheck": copy.deepcopy(_RC_HEALTHCHECK),
        "depends_on": (
            {"mongo-init": {"condition": "service_completed_successfully"}}
            if official
            else ["mongodb"]
        ),
    }

    # Single instance (the default): one `rocketchat` service, unchanged. Many
    # instances: clone it into rocketchat-1..N behind a load balancer.
    rc_services: dict = (
        {"rocketchat": rocketchat} if n == 1
        else _instance_services(rocketchat, n, spec.host_port, spec.container_port)
    )
    return rc_services


def build(spec: Spec) -> dict:
    """Return the compose document (a plain dict) for `spec`."""
    official = spec.mongo_flavor == "official"
    n = max(1, spec.preset.instances or 1)

    rc_services = _rocketchat_services(n, official, spec)

    services: dict = dict(rc_services)
    services.update(
        _mongo_service_official(spec) if official else _mongo_service_bitnami(spec)
    )

    doc: dict = {
        "name": spec.project_name,
        "services": services,
        "volumes": {"mongodb_data": {"driver": "local"}},
    }

    # --- apply the preset's backing services / volumes / RC patch / depends_on ---
    if spec.preset.services:
        _deep_merge(doc["services"], copy.deepcopy(spec.preset.services))
    if spec.preset.volumes:
        doc["volumes"].update(copy.deepcopy(spec.preset.volumes))
    # The RC patch and extra depends_on apply to EVERY rocketchat instance.
    for svc in rc_services.values():
        if spec.preset.rocketchat:
            _deep_merge(svc, copy.deepcopy(spec.preset.rocketchat))
        _add_depends(svc, spec.preset.depends_on)

    _publish_through_entry_service(doc, rc_services, spec)

    # --- HTTPS ---
    # Nothing here. A workspace never terminates TLS: the edge does, for all of
    # them, and it reaches this one over the private network compose already made.
    #
    # So this document is IDENTICAL whether the workspace serves https or not,
    # which is the property the whole design rests on -- adding or removing a name
    # is a route file appearing or disappearing, and no container is ever rebuilt
    # to gain or lose TLS. The previous version emitted either a Traefik sidecar or
    # a shared-network join depending on a flag resolved at CREATE time, and every
    # painful thing about it (port arbitration, `--adopt`, recreating containers to
    # migrate) came from that decision being frozen into this file.
    #
    # RC keeps its published http port. houston's own API calls use it (see
    # Metadata.public_url), so nothing internal has to trust the local CA, and
    # `curl http://localhost:<port>` still works for debugging.

    _attach_monitoring(doc, rc_services, spec)

    _bind_ports(doc, spec.bind_host)

    return doc


#: "8000-8005:8000-8005", and the single-sided "8000-8005" form.
_RANGE_RE = re.compile(r"^\d+-\d+(:\d+(-\d+)?)?$")


def _bind_ports(doc: dict, bind: str) -> None:
    """Prefix every published port with the bind host, unless one is already
    given. Applied to ALL services in one pass — RC, multi-instance direct
    ports, the load balancer, and preset sidecars — mirroring the official
    rocketchat-compose `${BIND_IP}:${HOST_PORT}:${PORT}` pattern."""
    if not bind:
        return
    for name, svc in doc["services"].items():
        ports = svc.get("ports")
        if not ports:
            continue
        out: list[str] = []
        for p in ports:
            # THE TYPE CHECK COMES FIRST. `str(p)` on compose long syntax gives
            # "{'target': 80, 'published': 8080}", which contains two colons and so
            # matched the already-IP-qualified branch below -- the dict's repr was
            # appended as a ports entry. Any shape that is not a string has to be
            # recognised before it is stringified.
            if isinstance(p, dict):
                long = dict(p)
                if "published" in long and not long.get("host_ip"):
                    long["host_ip"] = bind
                out.append(long)
                continue
            s = str(p)
            if s.count(":") >= 2:
                # Already IP-qualified ("127.0.0.1:8025:8025") — prefixing again
                # would produce a double-IP mapping.
                out.append(s)
            elif s.count(":") == 1 and s.split(":", 1)[0].isdigit():
                out.append(f"{bind}:{s}")                 # "8025:8025"
            elif s.isdigit():
                # A BARE container port. "127.0.0.1:8025" would be parsed as
                # host:container with an invalid host port, so use compose's
                # IP::CONTAINER form: an ephemeral host port, still bound to
                # `bind` rather than every interface.
                out.append(f"{bind}::{s}")
            elif _RANGE_RE.match(s):
                # A PORT RANGE ("8000-8005:8000-8005"). This fell through to the
                # `else` below and was appended UNCHANGED, so it published on every
                # interface while `info` and the detail panel both reported the
                # workspace as loopback-bound: a silent opt-out of the posture
                # `config.DEFAULT_BIND_HOST`'s own comment describes, on a workspace
                # running fixed weak credentials. Legal Compose, and reachable through
                # the custom presets the README documents.
                # A one-sided range means CONTAINER ports with ephemeral host
                # ports. Preserve that with IP::RANGE; IP:RANGE is interpreted
                # as HOST:CONTAINER and rejected because an IP is not a port.
                out.append(f"{bind}:{s}" if ":" in s else f"{bind}::{s}")
            else:
                # NOT SILENTLY PASSED THROUGH. Everything above is a shape this
                # function understands; anything else is a published port it would be
                # leaving on every interface, which is the one outcome that must never
                # be the default. Named so the preset author can see what to change.
                raise ValidationError(
                    f"port entry {p!r} in service {name!r} is a shape houston cannot "
                    f"bind to {bind}. Write it as \"HOST:CONTAINER\", a range, or "
                    f"compose long syntax with `published:` -- leaving it unbound "
                    f"would publish it on every interface.")
        svc["ports"] = out


# --- the reader the file is written for ----------------------------------------
# `safe_dump` writes a string PLAIN when PyYAML's resolver would read the bare text back as
# a string, and that resolver is YAML 1.1's. docker compose reads the file with compose-go,
# whose resolver is yaml.v3's -- YAML 1.2's numbers, plus the underscores, `0b` and
# timestamps it kept -- so a string YAML 1.1 leaves alone reached the container as a
# number: `env --set E1=1e8` gave E1=1e+08, `0o17` gave 15, `-.5` gave -0.5, `12e03` gave
# 12000, `08` gave 8, `2001-1-2` gave `2001-01-02 00:00:00 +0000 UTC`, and
# `2001-1-2T3:4:5+24:00` made docker refuse the whole file. Measured with `docker compose
# -f FILE config --format json` over every string of up to four characters of
# `0-9 + - . _ : a-f E o x O X B` and the lookalikes: 8,133 of 558,352 came back other than
# they went in, every one of them written plain (s3-python-contract-bugs).
#
# So the dumper the compose file is written with also knows what that reader types, the
# way `add_implicit_resolver` teaches any resolver, and the emitter then quotes such a
# string by its own rules -- in single quotes, as it already quotes `'3000'` and `'yes'`.
# The patterns are yaml.v3's `resolve()`, and they match every value measured:
#   - from a sign or a digit, and read with every `_` taken out, a Go integer literal
#     (`0x`/`0o`/`0b` in either case, a leading-zero octal) or a decimal float with an
#     optional unsigned exponent -- `strconv.ParseInt`/`ParseUint` base 0, then
#     `yamlStyleFloat`. A leading-zero decimal with an 8 or 9 in it is a float there;
#   - from a `.`, `strconv.ParseFloat` itself: digits, an exponent, and an underscore only
#     between two digits;
#   - `2006-1-2`, and that date followed by `T`/`t` and `15:4:5`, an optional fraction
#     after `.` or `,`, and `Z` or `±hh:mm`; or by spaces and the time with no zone --
#     each field one or two digits and in range, as `time.Parse` checks them.
# What the patterns cannot see is a magnitude: a float past the double range (`1e999`), an
# integer past 64 bits in `0x`/`0o`/`0b`, or 29 February of a common year stay strings to
# yaml.v3 and are quoted anyway, which reads back the same. Numbers the document holds as
# ints are not strings and are untouched. config.yaml, which PyYAML reads back, keeps
# `yaml.safe_dump`.
class _ComposeDumper(yaml.SafeDumper):
    """`SafeDumper`, whose resolver also types what docker compose's reader types."""


_TIME = r"(?:[01]?[0-9]|2[0-3]):[0-5]?[0-9]:[0-5]?[0-9](?:[.,][0-9]+)?"
for _tag, _regexp, _first in (
    ("tag:yaml.org,2002:int", re.compile(r'''^(?:[-+]_*)?
        (?:0_*[xX]_*(?:[0-9a-fA-F]_*)+
          |0_*[oO]_*(?:[0-7]_*)+
          |0_*[bB]_*(?:[01]_*)+
          |(?:(?:[0-9]_*)+(?:\._*(?:[0-9]_*)*)?|\._*(?:[0-9]_*)+)
           (?:[eE]_*(?:[-+]_*)?(?:[0-9]_*)+)?)$''', re.X), "-+0123456789"),
    ("tag:yaml.org,2002:float", re.compile(r'''^\.[0-9]+(?:_[0-9]+)*
        (?:[eE][-+]?[0-9]+(?:_[0-9]+)*)?$''', re.X), "."),
    ("tag:yaml.org,2002:timestamp", re.compile(r'''^[0-9]{4}-
        (?:(?:0?[13578]|1[02])-(?:0?[1-9]|[12][0-9]|3[01])
          |(?:0?[469]|11)-(?:0?[1-9]|[12][0-9]|30)
          |0?2-(?:0?[1-9]|[12][0-9]))
        (?:[Tt]''' + _TIME + r'''(?:Z|[-+](?:[01][0-9]|2[0-4]):(?:[0-5][0-9]|60))
          |[ ]+''' + _TIME + r''')?$''', re.X), "0123456789"),
):
    _ComposeDumper.add_implicit_resolver(_tag, _regexp, list(_first))


def to_yaml(doc: dict) -> str:
    header = "# Generated by houston. Do not edit by hand -- re-run `houston up`.\n"
    return header + yaml.dump(doc, Dumper=_ComposeDumper, sort_keys=False,
                              default_flow_style=False)
