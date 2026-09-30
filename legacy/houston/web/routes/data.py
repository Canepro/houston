"""Putting data INTO a workspace: sample rooms, bulk prefill, a customer's settings.

`seed` and `scale` are the two halves of "make this look like the customer's box" —
`seed` writes a deterministic manifest of rooms through the REST API and reads it back
to check it, `scale` prefills Mongo in bulk and tags what it wrote so the same tag can
undo it.

The settings import is two calls on purpose. `POST .../config-import/plan` parses an
uploaded support dump and answers with what it WOULD apply and what it would skip;
`POST .../config-import` applies a plan the caller has seen. The upload is capped, its
id is pattern-checked before it is ever joined to a path, and old uploads are pruned —
an unbounded read of an attacker-named file into memory is three separate mistakes.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import Body, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from houston import runner
from houston.errors import ValidationError
from houston.services import data as datasvc
from houston.services import lifecycle as lc
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name -- but `register` is the only thing anything outside this
#: package may reach for, and a test walks the imports to prove nothing does.
__all__ = ("register",)


# An uploaded support dump is read into memory; cap it rather than trusting it.
MAX_UPLOAD_BYTES = 16 * 1024 * 1024


_UPLOAD_ID_RE = re.compile(r"^u[0-9a-f]{12}$")


def _only_set(only: str) -> set[str] | None:
    """Parse the comma-separated id-prefix filter into a set, or None for 'all'."""
    return {p.strip() for p in (only or "").split(",") if p.strip()} or None


def _prune_uploads(dest: Path, keep: int = 5) -> None:
    """Keep only the newest `keep` uploads.

    A previewed-but-never-applied dump has nothing to delete it, and these are
    customers' configuration files — they should not accumulate indefinitely.
    """
    uploads = sorted(dest.glob("u*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in uploads[keep:]:
        stale.unlink(missing_ok=True)
        stale.with_suffix(".only").unlink(missing_ok=True)


def _read_upload(file: UploadFile) -> bytes:
    """Read an upload with a hard cap (it used to be an unbounded .read())."""
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValidationError(
            f"settings file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    return data


def seed(request: Request, name: str, body: dict = Body(default={})):
    meta = runner.read_meta(lc.resolve_name(name))
    job = _deps.jobs(request).submit("seed", lc.run_seed_inline, meta,
                      body.get("profile", "small"), bool(body.get("stats", False)),
                      label=meta.name)
    return {"job_id": job.id}


def scale(request: Request, name: str, body: dict = Body(...)):
    target = lc.resolve_name(name)
    job = _deps.jobs(request).submit("scale", datasvc.run_scale, target, body.get("scale", ""), label=target)
    return {"job_id": job.id}


def clear_scale(request: Request, name: str):
    target = lc.resolve_name(name)
    job = _deps.jobs(request).submit("clear-scale", datasvc.clear_scale, target, label=target)
    return {"job_id": job.id}


def config_import_plan(name: str, file: UploadFile = File(...), only: str = Form("")):
    target = lc.resolve_name(name)
    dest = runner.workspace(target) / "import"
    dest.mkdir(parents=True, exist_ok=True)
    # One file per upload, not a single shared settings.json: two tabs
    # previewing different dumps raced, and the second silently won the
    # first's apply.
    upload_id = "u" + uuid.uuid4().hex[:12]
    (dest / f"{upload_id}.json").write_bytes(_read_upload(file))
    # Pin the filter TO the upload. `apply` used to re-read `only` from its own
    # request, so editing the field after previewing silently applied a different
    # plan than the one that was reviewed — which defeats having a preview.
    (dest / f"{upload_id}.only").write_text(only, encoding="utf-8")
    _prune_uploads(dest)
    onlyset = _only_set(only)
    plan = datasvc.import_plan(target, str(dest / f"{upload_id}.json"), only=onlyset)
    plan["upload_id"] = upload_id
    return plan


def _import_then_delete(target: str, path: str, onlyset, emit) -> dict:
    """Apply the plan, then remove the uploaded dump — it is a customer's
    configuration and was previously left in the workspace forever."""
    try:
        return datasvc.import_apply(target, path, onlyset, emit=emit)
    finally:
        Path(path).unlink(missing_ok=True)
        Path(path).with_suffix(".only").unlink(missing_ok=True)


def config_import_apply(request: Request, name: str, body: dict = Body(default={})):
    target = lc.resolve_name(name)
    upload_id = str(body.get("upload_id") or "")
    # Pattern-checked before it becomes a filename.
    if not _UPLOAD_ID_RE.match(upload_id):
        return JSONResponse({"error": "missing or malformed upload_id - preview the plan first",
                             "kind": "ValidationError"}, status_code=400)
    path = runner.workspace(target) / "import" / f"{upload_id}.json"
    if not path.exists():
        return JSONResponse({"error": "no uploaded settings.json - preview the plan first",
                             "kind": "ValidationError"}, status_code=400)
    # The filter is whatever the PREVIEW used, not whatever this request says:
    # what was reviewed is what gets applied. `body["only"]` is ignored.
    onlyfile = path.with_suffix(".only")
    onlyset = _only_set(onlyfile.read_text(encoding="utf-8") if onlyfile.exists() else "")
    job = _deps.jobs(request).submit("config-import", _import_then_delete, target, str(path), onlyset,
                      label=target)
    return {"job_id": job.id}


ROUTES = (
    ("post", "/api/repros/{name}/seed", seed),
    ("post", "/api/repros/{name}/scale", scale),
    ("delete", "/api/repros/{name}/scale", clear_scale),
    ("post", "/api/repros/{name}/config-import/plan", config_import_plan),
    ("post", "/api/repros/{name}/config-import", config_import_apply),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
