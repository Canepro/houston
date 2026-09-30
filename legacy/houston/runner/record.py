"""record -- see the package docstring."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from houston import config
from houston.errors import MissingRecordError

from houston.runner import locks
from houston.runner import paths

@dataclass
class Metadata:
    name: str
    project: str
    rc_version: str
    rc_image: str
    mongo_tag: str
    mongo_flavor: str
    preset: str
    root_url: str
    host_port: int
    version_source: str
    pinned: bool = False
    created_at: str = ""
    # External https URL when `up --https` was used. Kept SEPARATE from root_url,
    # which stays the plain http://localhost:<port> that houston's own API calls
    # (login, PAT, seeding, load tests) use. Pointing those at a locally-signed
    # https URL would fail certificate verification in 71 call sites; RC still
    # advertises this one as its ROOT_URL, which is what the browser needs.
    public_url: str = ""
    # The Rocket.Chat admin password FOR THIS WORKSPACE, when one was generated.
    # Empty means the shared `config.ADMIN_PASSWORD` -- which is every workspace
    # made before this field existed, and every loopback one made after. Read it
    # through `admin_pass` below, never directly, so the fallback is not a thing
    # each of sixty call sites has to remember.
    admin_password: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def external_url(self) -> str:
        """What a human/browser should open — the https URL if there is one."""
        return self.public_url or self.root_url

    @property
    def admin_pass(self) -> str:
        """This workspace's admin password.

        `config.ADMIN_PASSWORD` is the fixed `admin123`, and loopback is WHY that is
        acceptable -- `config.DEFAULT_BIND_HOST`'s own comment says so. A workspace
        reachable beyond loopback removes that premise, so `create_repro` generates
        one for it and stores it here.

        Everything that logs in reads THIS, not the constant: houston's own REST
        calls (readiness, PATs, seeding, settings, load tests) would otherwise all
        authenticate with `admin123` against a workspace whose admin password is not
        `admin123`, and `pat`, `api`, `seed`, `loadtest`, `monitor` and `upgrade`
        would each fail with a 401 nobody could explain.

        The empty fallback is not a default so much as a version marker: a repro.json
        written before this field existed means a workspace whose Rocket.Chat really
        does run `admin123`, and it has to keep working untouched.
        """
        return self.admin_password or config.ADMIN_PASSWORD

def recorded(name: str, field: str) -> str:
    """A value this workspace WROTE DOWN when it was created, or "" if there is none.

    Reads the dataclass field first and falls back to the `extra` bag, because the
    three identities that matter here were persisted in two different places for
    historical reasons and a caller should not have to know which.

    Never raises. Every caller has a mint-time default to fall back on, and a
    workspace that is half-written, unreadable, or written by a newer houston must
    degrade to "derive it" rather than turn a name lookup into an error.
    """
    try:
        meta = read_meta(name)
    except (MissingRecordError, OSError, ValueError, TypeError):
        return ""
    value = getattr(meta, field, None)
    if value in (None, "") and isinstance(meta.extra, dict):
        value = meta.extra.get(field)
    return str(value or "")

def project_name(name: str) -> str:
    """The Compose project this workspace's containers ACTUALLY live under.

    RECORDED, not derived. `PROJECT_PREFIX` says what a new workspace gets; it does
    not describe one that already exists. Deriving it here made the prefix and the
    containers on the daemon two independent sources of truth that merely happened
    to agree -- and they stop agreeing the moment the prefix changes, which is not
    hypothetical: this tool was renamed. At that point `list` reads the recorded
    project and reports the workspace running, while `down` derives a different one
    and tears down nothing, leaking the containers along with their ports and the
    customer's Mongo volume. `read_meta` is the same file `list` already reads.
    """
    return recorded(name, "project") or paths.mint_project_name(name)

def write(name: str, compose_yaml: str, meta: Metadata,
          files: list[tuple[str, str]] | None = None) -> None:
    ws = paths.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    # The generated compose file carries ADMIN_PASS and, when set, REG_TOKEN, and
    # preset files carry LDAP and MinIO credentials -- all of it written at the
    # process umask, which on a normal box leaves them readable by every local
    # user. That is tolerable on a laptop and not on the shared server this branch
    # is for, where "your own workspace" is the whole point. Applied on every
    # write, so workspaces created before this are tightened when next touched.
    paths._restrict(ws)
    # Write atomically (temp + rename): an interruption mid-write must not leave a
    # half-written repro.json that read_meta would choke on, nor a compose file
    # out of sync with its metadata.
    #
    # THE RECORD FIRST, and the order is the whole point. Each write is individually
    # atomic; the PAIR is not, and a kill between them leaves a directory that
    # `exists()` accepts. Compose-first left the half that `list_meta` skips and
    # `read_meta` cannot read -- a workspace invisible to `list`, `prune` and port
    # allocation while still occupying its name. Record-first leaves the half that
    # is fully visible and whose compose file `up` regenerates anyway, which is
    # already this tool's contract for that document.
    paths.atomic_write(ws / "repro.json", json.dumps(asdict(meta), indent=2))
    paths.atomic_write(ws / "docker-compose.yml", compose_yaml)
    # Preset-generated files (e.g. a seeded LDIF that a service mounts).
    # `{{ROOT_URL}}` is substituted with the repro's URL — presets are built
    # before the host port is known, so a generated file that must reference the
    # workspace URL (e.g. the livechat widget embed snippet) uses the placeholder.
    for relpath, content in files or []:
        fp = ws / relpath
        fp.parent.mkdir(parents=True, exist_ok=True)
        # The ADVERTISED url, falling back to the loopback one. A generated file
        # carrying this placeholder is read by a BROWSER, and `meta.root_url` is the
        # address houston uses for its own API calls -- always loopback, by contract.
        # Substituting that shipped a livechat demo page that only worked on the
        # machine docker runs on.
        advertised = (meta.extra.get("advertised_url")
                      if isinstance(meta.extra, dict) else "") or meta.root_url
        fp.write_text(content.replace("{{ROOT_URL}}", advertised), encoding="utf-8")
    paths._restrict(ws)          # again: covers the files just written, and their dirs

_META_FIELDS = frozenset(f.name for f in fields(Metadata))

def read_meta(name: str) -> Metadata:
    """Load a repro's metadata.

    Unknown keys are dropped rather than raising: a repro.json written by a NEWER
    houston carrying an added field would otherwise TypeError, and `list_meta`
    swallows that — silently making the repro vanish from `houston list`.
    """
    # A TYPED error, not a raw FileNotFoundError. `exists()` accepts either marker
    # and this needs repro.json, so a directory left with only a compose file --
    # a SIGKILL, an OOM or a host reboot between the two writes below -- resolved
    # fine and then raised out of `detail`/`describe` on the request thread, which
    # in `serve` is a 500 with a traceback rather than the documented ReproError ->
    # status mapping. It is now a 404 that says how to finish or remove it.
    record = paths.workspace(name) / "repro.json"
    if not record.exists():
        raise MissingRecordError(
            f"{name!r} has no repro.json, so it is a half-written workspace rather "
            f"than one houston can act on — finish it with `houston up --name "
            f"{name}`, or remove it with `houston down --name {name} --volumes`")
    blob = json.loads(record.read_text(encoding="utf-8"))
    if not isinstance(blob, dict):
        raise TypeError("repro.json is not a JSON object")
    return Metadata(**{k: v for k, v in blob.items() if k in _META_FIELDS})

def write_record(name: str, meta: "Metadata") -> None:
    """Write just `repro.json`, for a workspace that has no compose document.

    The Kubernetes path has no docker-compose.yml to write, so it called
    `atomic_write` directly -- and `_restrict()` lives in `write()`, which it
    therefore never reached. That left the whole workspace directory at the process
    umask on the one runtime that ALSO writes `kubernetes/values.yaml` carrying
    ADMIN_PASS, so a generated per-workspace admin password was readable by every
    local user. `write()`'s own comment says the 0700 DIRECTORY is what does the
    work; this is the same guarantee for the runtime that had no way to ask for it.
    """
    ws = paths.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    paths._restrict(ws)
    paths.atomic_write(ws / "repro.json", json.dumps(asdict(meta), indent=2))
    paths._restrict(ws)          # again: covers anything written into it since

def update_meta(name: str, mutate) -> "Metadata":
    """Read-modify-write repro.json under the repro lock.

    Every other mutator holds this lock while it rewrites the workspace, so a
    metadata edit that skipped it could be lost by a concurrent `up --force`
    rewriting the same file from the spec. `mutate(meta)` edits in place.
    """
    with locks.repro_lock(name, timeout=60.0):
        meta = read_meta(name)
        mutate(meta)
        paths.atomic_write(paths.workspace(name) / "repro.json", json.dumps(asdict(meta), indent=2))
        return meta

def read_compose(name: str) -> dict:
    """Load a repro's generated docker-compose.yml as a dict (for in-place edits
    like attaching/detaching the monitoring stack)."""
    import yaml
    return yaml.safe_load((paths.workspace(name) / "docker-compose.yml").read_text(encoding="utf-8")) or {}

def list_meta() -> list[Metadata]:
    root = config.repros_dir()
    if not root.exists():
        return []
    out: list[Metadata] = []
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        try:
            out.append(read_meta(d.name))
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            continue  # skip half-written / foreign dirs
    return out

def rc_services(name: str) -> list[str]:
    """The repro's Rocket.Chat service names, read from its compose file.

    A multi-instance repro has rocketchat-1..N rather than one `rocketchat`, and
    quiescing only the first would leave the others writing during a dump.
    """
    try:
        doc = read_compose(name)
    except (OSError, ValueError):
        return []
    return sorted(s for s in (doc.get("services") or {})
                  if s == "rocketchat" or s.startswith("rocketchat-"))
