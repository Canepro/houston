"""Snapshots and version moves: backup, restore, upgrade, roll back.

One subject, not two. An upgrade takes a backup first and a rollback restores it, so
splitting them would put the two halves of one operation in different files.

**Every bundle path is confined before it is used.** `_confined_backup_in` and
`_confined_backup_out` resolve a caller-supplied path and refuse anything outside the
backups directory — these endpoints read and write files named by the request, and the
GUI is reachable from whatever `--allow-host` admits.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, Request

from houston import runner
from houston.errors import ValidationError
from houston.services import lifecycle as lc
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name -- but `register` is the only thing anything outside this
#: package may reach for, and a test walks the imports to prove nothing does.
__all__ = ("register",)


def _confined_backup_in(bundle: str, backupsvc) -> str:
    """A caller-supplied bundle to READ, restricted to the managed directory.

    The WRITE side was deliberately confined -- "unconfined, this wrote a tar.gz
    anywhere the server user could" -- and the read side was not. `POST /api/restore`
    and `POST /api/backups/compatibility` both took the path straight to
    `Path(bundle).expanduser()`, so a member+ got a filesystem oracle with three
    distinguishable answers (no such file / not a bundle / a manifest) plus tarfile's
    error text for any readable `.tar.gz` on the box.

    Not remote code execution -- `_safe_members` rejects absolute paths, `..` and links,
    and `extractall(filter="data")` is a second layer -- but the CLI is where an
    arbitrary path belongs, not the HTTP API.
    """
    if not bundle:
        raise ValidationError("no bundle given")
    root = backupsvc.backups_dir().resolve()
    src = Path(bundle).expanduser()
    if not src.is_absolute():
        src = root / src
    try:
        src = src.resolve()
    except OSError as exc:
        raise ValidationError(f"could not read {bundle!r}: {exc}") from exc
    if src != root and root not in src.parents:
        raise ValidationError(
            f"`bundle` must be inside {root} — the HTTP API cannot read arbitrary "
            "paths on the server (the CLI still can)")
    return str(src)


def _confined_backup_out(out: str, backupsvc) -> str:
    """A caller-supplied backup destination, restricted to the managed directory.

    resolve() before comparing, so `..` and a symlink pointing out are both caught
    rather than only literal prefixes.
    """
    if not out:
        return ""
    root = backupsvc.backups_dir().resolve()
    dest = Path(out).expanduser()
    if not dest.is_absolute():
        dest = root / dest
    dest = dest.resolve()
    if dest != root and root not in dest.parents:
        raise ValidationError(
            f"`out` must be inside {root} — the HTTP API cannot choose arbitrary "
            "paths on the server (the CLI's --out still can)")
    return str(dest)


def backup_create(request: Request, name: str, body: dict = Body(default={})):
    """Dump the repro's database into a bundle. A job: minutes on a seeded repro."""
    from houston.services import backup as backupsvc
    target = lc.resolve_name(name)
    # `out` chooses a path on the SERVER. Over HTTP the caller is remote, so it
    # is confined to the managed backup directory: unconfined, this wrote a
    # tar.gz anywhere the server user could -- a systemd drop-in directory, a
    # webroot -- and combined with a forged cross-site request the attacker
    # chose the path too. The CLI keeps an unconfined --out on purpose: there
    # the caller IS the user, at their own shell.
    out = _confined_backup_out(str(body.get("out") or ""), backupsvc)
    job = _deps.jobs(request).submit("backup", backupsvc.create, target, label=target,
                      out=out,
                      note=str(body.get("label") or ""),
                      live=bool(body.get("live", False)))
    return {"job_id": job.id}


def backups_list(name: str = ""):
    from houston.services import backup as backupsvc
    return {"backups": backupsvc.list_backups(name)}


def backup_delete(path: str):
    from houston.services import backup as backupsvc
    return backupsvc.delete(path)


def backup_compatibility(body: dict = Body(...)):
    """Whether a bundle may be restored into a repro — asked BEFORE committing.

    The restore dialog enables its button from this, so a user learns that a
    downgrade is refused while choosing, not after starting a job.
    """
    from houston.services import backup as backupsvc
    bundle = _confined_backup_in(str(body.get("bundle") or ""), backupsvc)
    manifest = backupsvc.read_manifest(bundle)
    target = str(body.get("name") or "")
    if not target:
        return {"manifest": manifest, "compatibility": None}
    meta = runner.read_meta(lc.resolve_name(target))
    return {"manifest": manifest,
            "compatibility": backupsvc.compatibility(manifest, meta)}


def restore(request: Request, body: dict = Body(...)):
    from houston.services import backup as backupsvc
    bundle = _confined_backup_in(str(body.get("bundle") or ""), backupsvc)
    job = _deps.jobs(request).submit("restore", backupsvc.restore, bundle,
                      name=str(body.get("name") or ""),
                      new=bool(body.get("new", False)),
                      allow_upgrade=bool(body.get("allow_upgrade", False)),
                      force=bool(body.get("force", False)),
                      label=str(body.get("name") or Path(bundle).name))
    return {"job_id": job.id}


def upgrade_state(name: str, to: str = "", offline: bool = False):
    """Whether Upgrade may be offered, and what a given target would do.

    Without `to` this is just the gate: the GUI renders the action only for a
    RUNNING workspace, because the pre-upgrade backup needs MongoDB up and the
    migrations only run when Rocket.Chat boots.
    """
    from houston.services import upgrade as upgradesvc
    state = upgradesvc.can_upgrade(name)
    if to and state["can_upgrade"]:
        state["plan"] = upgradesvc.plan(name, to, offline=offline)
    return state


def upgrade_run(request: Request, name: str, body: dict = Body(...)):
    from houston.services import upgrade as upgradesvc
    target = lc.resolve_name(name)
    to = str(body.get("to") or "")
    if not to:
        raise ValidationError("no target version given, e.g. {\"to\": \"8.6.1\"}")
    job = _deps.jobs(request).submit("upgrade", upgradesvc.run, target, to,
                      offline=bool(body.get("offline", False)),
                      force=bool(body.get("force", False)),
                      no_backup=bool(body.get("no_backup", False)),
                      rollback_on_failure=bool(body.get("rollback_on_failure", True)),
                      label=target)
    return {"job_id": job.id}


def upgrade_rollback(request: Request, name: str, body: dict = Body(default={})):
    from houston.services import backup as backupsvc
    from houston.services import upgrade as upgradesvc
    target = lc.resolve_name(name)
    # Through the same confinement helper as /api/restore and
    # /api/backups/compatibility. This third route was missed, so `bundle` went
    # straight to `Path().expanduser()` and gave a member+ a filesystem oracle
    # with distinguishable answers, readable back from GET /api/jobs/{id} at
    # readonly+. Only when non-empty: empty legitimately means "use the bundle
    # recorded on the workspace", which is the ordinary way to call this.
    raw = str(body.get("bundle") or "")
    bundle = _confined_backup_in(raw, backupsvc) if raw else ""
    job = _deps.jobs(request).submit("rollback", upgradesvc.rollback, target,
                      bundle=bundle, label=target)
    return {"job_id": job.id}


ROUTES = (
    ("post", "/api/repros/{name}/backup", backup_create),
    ("get", "/api/backups", backups_list),
    ("delete", "/api/backups", backup_delete),
    ("post", "/api/backups/compatibility", backup_compatibility),
    ("post", "/api/restore", restore),
    ("get", "/api/repros/{name}/upgrade", upgrade_state),
    ("post", "/api/repros/{name}/upgrade", upgrade_run),
    ("post", "/api/repros/{name}/upgrade/rollback", upgrade_rollback),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
