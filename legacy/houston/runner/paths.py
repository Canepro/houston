"""paths -- see the package docstring."""
from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path
from houston import config


def atomic_write(path: Path, content: str, *, mode: int | None = None) -> None:
    """Write via a temp file in the same dir + os.replace, so readers never see a
    partially written file (rename is atomic on the same filesystem).

    The temp name is unique per call: a fixed `<name>.tmp` meant two concurrent
    writers (two web jobs touching the same repro) shared one temp path and
    clobbered each other, defeating the atomicity this exists to provide.

    `mode` is applied to the TEMP FILE, before the rename -- so the target never exists
    at the umask's permissions even for an instant. Callers writing a private key pass
    0o600: `edge.issue_local_cert` wrote `certs/<host>.key` through here and it landed
    at whatever the umask allowed, typically 0644, on a box where `~/.houston` is only
    tightened to 0700 by `serve` or a config save -- neither of which runs on a
    CLI-only `up --https`.
    """
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)   # no-op after a successful replace

def mint_project_name(name: str) -> str:
    """The Compose project a NEW workspace's containers are created under."""
    return config.PROJECT_PREFIX + name

def workspace(name: str) -> Path:
    return config.repros_dir() / name

def exists(name: str) -> bool:
    """Whether a workspace is here, whatever runtime it runs on.

    This used to be `(workspace/docker-compose.yml).exists()` -- a repro WAS a
    compose file, which was true of every workspace this tool had ever made. A
    Kubernetes workspace has no compose file, so it would have been invisible to
    `list`, `info`, `down` and the name-collision check, and `up` would have
    silently created a second one over the top of it.

    Either marker counts, which is strictly more permissive than before: no
    workspace that used to be found can stop being found.

    It is deliberately more permissive than `read_meta`, and that gap is a real
    state rather than an oversight: each file goes through `atomic_write` but the
    PAIR is not atomic, so a kill between them leaves a directory this accepts and
    `read_meta` rejects. Staying permissive is what lets `down` clean such a
    directory up; `write()` now writes repro.json FIRST so the surviving half is
    the one that can be read, and `read_meta` raises `MissingRecordError` -- a 404,
    not a traceback -- for the other order left behind by an older version.
    """
    ws = workspace(name)
    return (ws / "docker-compose.yml").exists() or (ws / "repro.json").exists()

def _restrict(root: Path) -> None:
    """Keep a workspace's contents away from other local users. Best-effort.

    The DIRECTORY is what does the work: 0700 means no other user can traverse
    into the workspace, so nothing inside it is reachable whatever its own mode.
    Files are left group/other readable, and that is not a compromise -- it is
    required. Half of what lives here is bind-mounted INTO a container, and those
    run as non-root (Prometheus as 65534, Grafana, Loki, the OTel collector), so
    0600 made them unreadable and Prometheus crash-looped on
    "open /etc/prometheus/prometheus.yml: permission denied".

    Only the ROOT is 0700. Nested directories are 0755, because some volumes
    mount a DIRECTORY rather than a file and the container then has to list it --
    Prometheus globs `/etc/prometheus/file_sd_configs/*.yml`, and with that
    directory at 0700 it started cleanly and scraped nothing at all, which is
    worse than crashing.

    Both rules verified rather than reasoned about:

      mounted FILE       0644 inside a 0700 dir  -> readable  (the host path's
                         0600 inside a 0700 dir  -> refused    directories never
                                                                apply)
      mounted DIRECTORY  0700                    -> cannot list
                         0755 under a 0700 root  -> lists and reads

    The 0700 root is what keeps other local users out, and it keeps them out of
    every subdirectory too, whatever those are set to -- so the privacy goal and
    the containers do not actually conflict.

    Never fatal: a workspace on a filesystem that cannot represent these modes
    (some network shares) must still be usable -- refusing to create a repro over
    a permission bit would trade a small exposure for a broken tool.
    """
    try:
        root.chmod(0o700)
        for path in root.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
    except OSError:
        pass

def remove(name: str) -> None:
    shutil.rmtree(workspace(name), ignore_errors=True)
