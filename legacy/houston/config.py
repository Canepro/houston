"""Paths, constants, and the small persisted config for houston.

State lives under ~/.houston (override with HOUSTON_HOME):

    ~/.houston/
      config.yaml            # default_repro, bind_host, acme.*, gui.* — NO secrets:
                             #   reg_token is env/flag only and is never persisted
                             #   (see update_config's with_env=False)
      presets/               # user/team presets (override built-ins)
      repros/<name>/         # one workspace per repro
"""

from __future__ import annotations

import contextlib
import os
import secrets
import sys
import threading
import uuid
from pathlib import Path

import yaml

# Serialises read-modify-write of config.yaml (see update_config). THREADS only --
# `_config_flock` is the other half, for processes.
_CONFIG_LOCK = threading.Lock()

# Container-internal Rocket.Chat port. The published host port is chosen per repro.
RC_CONTAINER_PORT = 3000

# Docker compose project (and container) name prefix, so houston's stacks are
# easy to tell apart from unrelated compose projects.
PROJECT_PREFIX = "houston-"

# Admin user auto-provisioned into every repro (see presets / compose).
#
# ADMIN_PASSWORD is the LOOPBACK password, and that is the whole of its contract.
# `DEFAULT_BIND_HOST` below explains why a fixed weak credential is acceptable at
# all: nothing outside this machine can reach the workspace. A workspace that gets a
# public name or a non-loopback bind removes that premise, and `create_repro`
# generates one per workspace instead -- see `runner.Metadata.admin_pass`, which is
# what every login actually reads.
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin123"

#: Bytes of entropy in a generated workspace admin password. 15 bytes is 120 bits
#: through `token_urlsafe`, which is 20 characters -- long enough that the answer to
#: "is this brute-forcible from the internet" is not a calculation, short enough to
#: read off a terminal and type into a browser once. `services/users.py` spends 12
#: for GUI accounts, which are behind a lockout; a Rocket.Chat admin is not.
_ADMIN_PASSWORD_BYTES = 15


def generate_admin_password() -> str:
    """A fresh admin password for one workspace.

    `secrets`, not `random`: the module docstring in `services/users.py` makes the
    same point and it is the only thing that matters here.
    """
    return secrets.token_urlsafe(_ADMIN_PASSWORD_BYTES)
ADMIN_EMAIL = "admin@example.com"
ADMIN_NAME = "Admin"

# Host ports published by preset side services. One registry so presets can't
# silently collide with each other — a new preset picks a port by looking here.
# (RC's own port is allocated dynamically per repro; these are fixed for now —
# see runner.used_ports, which makes them visible to allocation/preflight.)
PRESET_PORTS: dict[str, tuple[int, ...]] = {
    "saml": (8081,),          # Keycloak (SAML)
    "oidc": (8085,),          # Keycloak (OIDC; same port inside+out)
    "email": (8025,),         # Mailpit web UI / API
    "s3_minio": (9000, 9001), # MinIO S3 API + console
    "livechat": (8090,),      # demo "customer website" embedding the widget
    "ldap": (8082,),          # phpLDAPadmin — browse the directory the preset seeded
}

# Host ports for the --monitor add-on (Prometheus, Grafana). Not a preset, so
# kept separate from PRESET_PORTS but treated the same for collision checks.
MONITOR_PORTS: tuple[int, int] = (9090, 5050)

# Host interface published ports bind to. Loopback: repros use weak fixed
# credentials, so they should not be reachable from the local network unless
# the user opts in (`up --bind 0.0.0.0` or HOUSTON_BIND_HOST). Matches the
# official rocketchat-compose .env.example posture for local/backing services.
DEFAULT_BIND_HOST = "127.0.0.1"

# In-network addresses of the Mongo replica set (compose service DNS).
MONGO_URL = "mongodb://mongodb:27017/rocketchat?replicaSet=rs0"
MONGO_OPLOG_URL = "mongodb://mongodb:27017/local?replicaSet=rs0"

# Key under Metadata.extra where the email preset records Mailpit's URL, so
# rcapi.login can fetch email-2FA codes for houston's own admin calls.
EXTRA_MAILPIT_URL = "mailpit_url"

# Key under Metadata.extra naming the runtime a workspace runs on. ABSENT means
# docker -- every workspace created before this key existed is a compose one, and
# `services/topology.py` reads a missing value as such rather than migrating
# repro.json. See that module for why the default is silent.
EXTRA_RUNTIME = "runtime"

# Key under Metadata.extra naming HOW Rocket.Chat is arranged (monolith /
# multi-instance / microservices). Absent on a workspace older than the key, where
# the deployment can still be recovered: it WAS the preset name.
EXTRA_DEPLOYMENT = "deployment"

# Key under Metadata.extra naming WHICH Kubernetes cluster a workspace runs in, by
# kubeconfig context name. Absent means houston's own cluster -- every workspace
# created before `--context` existed went wherever `plan_cluster` decided, and
# `k8s.CONTEXT` is what that resolved to. Read as
# `str((meta.extra or {}).get(EXTRA_CONTEXT) or k8s.CONTEXT)`, which was a bare
# "context" literal at sixteen sites before this constant existed.
EXTRA_CONTEXT = "context"

# Stored config key: the default `--context` for this box. FLAT, not dotted, and the
# reason is mechanical rather than stylistic -- _ENV_OVERRIDES below maps environment
# variables onto flat keys only, so a dotted stored key could never have an env
# override. `acme.email -> acme_email` is the family this joins; `gui.create_policy`,
# which keeps its dot IN the key, is the one it does not.
KUBE_CONTEXT_KEY = "kubernetes_context"

# Stored config key: which AWS accounts this box may build a cluster in. Comma
# separated, absent meaning none, and none meaning every create is gated.
#
# Keyed on the ACCOUNT rather than on a cluster name or a context, because the account
# is the thing that gets BILLED -- it is the unit somebody actually owns and can
# consent to. It is also per-machine on purpose: approval is a decision somebody made
# at a keyboard, and copying a repo to a new box should not carry it along.
CLOUD_ACCOUNTS_KEY = "cluster_approved_accounts"


def approved_aws_accounts() -> set[str]:
    """Accounts this box has been told it may spend in. Empty by default."""
    raw = str(load_config().get(CLOUD_ACCOUNTS_KEY) or "")
    return {part.strip() for part in raw.split(",") if part.strip()}


# RC's REST rate limiter — disabled for the duration of a load test (and the
# seed) so the offered load isn't throttled into a false result, then restored.
RC_RATE_LIMITER_SETTING = "API_Enable_Rate_Limiter"

# Environment overrides for config.yaml values (env wins over the file):
#   HOUSTON_REG_TOKEN  -> reg_token     HOUSTON_RC_IMAGE -> rc_image
#   HOUSTON_BIND_HOST  -> bind_host     (HOUSTON_HOME is handled in home())
#   HOUSTON_KUBE_CONTEXT -> kubernetes_context
#: Environment variables were spelled RC_REPRO_* before the rename. They are read
#: as deprecated aliases rather than dropped: a rename that only taught the tool the
#: new name would make an RC_REPRO_HOME sitting in someone's shell profile do nothing
#: at all -- not fail, just quietly resolve state to ~/.houston while every workspace
#: they own is somewhere else. Silence is the wrong failure for a variable whose only
#: job is to say where the state lives.
ENV_PREFIX = "HOUSTON_"
LEGACY_ENV_PREFIX = "RC_REPRO_"

#: Legacy names already warned about, so the stderr notice fires once per process
#: rather than on every lookup. This is presentation state only -- see below for why
#: it is deliberately NOT what `doctor` reports.
_legacy_env_warned: set[str] = set()


def legacy_env_used() -> "list[str]":
    """Pre-rename variable names set in THIS environment, sorted.

    Read from the environment rather than from a record of what this process happened
    to look up. A historical record answers "did anything read one yet", which depends
    on which commands ran in what order -- so `doctor` would report a variable that is
    no longer set, or stay silent about one that is simply not read on this code path.
    Neither is the question a person asks a preflight.
    """
    return sorted(name for name in os.environ if name.startswith(LEGACY_ENV_PREFIX))


def env(name: str, default: str = "") -> str:
    """Read `HOUSTON_<X>`, falling back to the pre-rename `RC_REPRO_<X>`.

    The new spelling always wins, so a box part-way through the migration with both
    set behaves as the new one says. The warning goes to STDERR, never stdout: under
    `--json` stdout carries the envelope and nothing else.
    """
    value = os.environ.get(name)
    if value is not None:
        return value
    if name.startswith(ENV_PREFIX):
        legacy = LEGACY_ENV_PREFIX + name[len(ENV_PREFIX):]
        value = os.environ.get(legacy)
        if value is not None:
            if legacy not in _legacy_env_warned:
                _legacy_env_warned.add(legacy)
                print(f"{legacy} is the pre-rename name for {name} and will stop "
                      f"being read; rename it.", file=sys.stderr)
            return value
    return default


_ENV_OVERRIDES = {
    "reg_token": "HOUSTON_REG_TOKEN",
    "rc_image": "HOUSTON_RC_IMAGE",
    "bind_host": "HOUSTON_BIND_HOST",
    KUBE_CONTEXT_KEY: "HOUSTON_KUBE_CONTEXT",
}


def default_kube_context() -> str:
    """The box's default `--context`, or "".

    ONE reader, because three callers need the same answer and disagreeing is a real
    failure rather than an untidiness: `up` decides where a workspace goes, the
    capacity preflight decides whose RAM to reserve, and `doctor` reports on a
    cluster. A default honoured by two of the three makes `doctor` a second opinion
    about the boot -- which k8s.py:1117 records as a bug already fixed once.
    """
    return str(load_config().get(KUBE_CONTEXT_KEY) or "").strip()


def home() -> Path:
    """Root state directory. RESOLVES a path; it does not create anything.

    The docstring said "created on demand", which reads as a promise this function
    makes and does not keep -- the mkdir lives in the two writers below (0700, because
    accounts and sessions live in here), so a reader who trusted this would file the
    resulting FileNotFoundError against the wrong function.
    """
    root = env("HOUSTON_HOME")
    base = Path(root) if root else Path.home() / ".houston"
    return base


def repros_dir() -> Path:
    return home() / "repros"


def preset_dir() -> Path:
    return home() / "presets"


def reports_dir() -> Path:
    """Where loadtest and capacity reports are written by default."""
    return home() / "reports"


def config_file() -> Path:
    return home() / "config.yaml"


#: What a person may type for a boolean setting, and what it means. Both directions
#: are listed because only one of them was ever exercised.
_TRUE = ("1", "true", "yes", "on", "y", "t")
_FALSE = ("0", "false", "no", "off", "n", "f", "")


def truthy(value, default: bool = False) -> bool:
    """Read a remembered boolean, however it happens to be stored.

    `bool("false")` IS TRUE, and that one line made `config set acme.staging false`
    impossible to obey: `config set` wrote the raw string, every reader did
    `bool(cfg.get("acme_staging"))`, and so turning staging ON worked while turning it
    OFF did nothing at all. Measured on a live box -- `acme_staging: 'false'` in
    config.yaml and the next create still ordering from the staging directory, with
    nothing anywhere saying why.

    The asymmetry is what hid it: the value people set first is the one that works.

    Needed on the READ side and not only at the point of writing, because every
    config.yaml already written by an older houston holds a string -- a box that
    once rehearsed against staging would otherwise stay there for ever.
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return default


def load_config(with_env: bool = True) -> dict:
    """Load ~/.houston/config.yaml (or {}), with env-var overrides applied.

    Pass with_env=False when the dict will be written back via save_config —
    otherwise ephemeral env values (e.g. HOUSTON_REG_TOKEN) would be persisted
    into the file.
    """
    path = config_file()
    data: dict = {}
    if path.exists():
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if isinstance(loaded, dict):
            data = loaded
    if with_env:
        for key, name in _ENV_OVERRIDES.items():
            val = env(name)
            if val:
                data[key] = val
    return data


def save_config(cfg: dict) -> None:
    """Persist config.yaml atomically (temp file + rename).

    A plain write_text could be read half-written — the web GUI runs service calls
    on worker threads, so concurrent readers are real.
    """
    # 0700 ON CREATE, so a box that never runs `serve` is not left depending on the
    # umask. `serve` tightens an existing loose home (cli.py) and `doctor` reports
    # one, but neither runs on a pure-CLI box -- and this directory also holds the
    # audit log, the accounts file and the ACME material. config.yaml itself holds no
    # secret (see the module docstring), so this is depth rather than a fix.
    home().mkdir(parents=True, exist_ok=True, mode=0o700)
    path = config_file()
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        # 0600 via os.open rather than write_text, which would take the umask.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(yaml.safe_dump(cfg, sort_keys=False))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)   # no-op after a successful replace


@contextlib.contextmanager
def _config_flock():
    """Hold an exclusive lock on config.yaml across PROCESSES, not just threads.

    `_CONFIG_LOCK` is a `threading.Lock`, which says nothing about a second process
    -- and two are the normal case here: `houston serve` runs continuously while
    somebody uses the CLI on the same box. Both read config.yaml, each mutates a
    different key, both write; the later `os.replace` wins and the other change is
    gone with nothing logged. Atomic replacement prevents a torn FILE, never a lost
    UPDATE, and those are different problems.

    Same two-layer shape as `runner.repro_lock`, for the same reason and with the
    same degradation: no fcntl (Windows) means thread-only, because a hard
    dependency would be worse than the race it prevents.
    """
    try:
        import fcntl

        from houston import lock
    except ImportError:                     # pragma: no cover - not POSIX
        yield
        return
    root = home()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(root / ".config.lock", os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        # ADDITIVE: flock does not exclude an OFD acquirer, so a second build would
        # take this lock while we hold it. See houston/lock.py for the measurement.
        lock.add_ofd_write_lock(fd)
        yield
    finally:
        os.close(fd)                        # releases the flock AND the OFD lock


def update_config(mutate) -> dict:
    """Read-modify-write config.yaml under a lock; `mutate(cfg)` edits in place.

    Serialised because the GUI's worker threads can otherwise interleave two
    read-modify-write cycles and lose one of the updates. Reads with
    with_env=False on purpose: this writes the file back, and an ephemeral
    HOUSTON_REG_TOKEN must never be persisted into it.
    """
    with _CONFIG_LOCK, _config_flock():
        cfg = load_config(with_env=False)
        mutate(cfg)
        save_config(cfg)
        return cfg
