"""Moving bytes in and out of a pod.
"""
from __future__ import annotations

from pathlib import Path
from houston import exec as subprocess

from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import namespace as kubens
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, INSTALL_TIMEOUT, MONGO_SERVICE

# --- backup/restore: the same five shapes, through kubectl ------------------------
#
# `backup.py` needs exactly five things from a runtime, and its logic -- the bundle
# format, the manifest, the safety checks -- is runtime-agnostic. So these mirror
# runner's compose_exec_* signatures rather than inventing a shape, and backup.py
# picks between them. Anything else there stays shared.

def exec_capture(name: str, argv: list[str], *, context: str,
                 timeout: float | None = None) -> tuple[int, str]:
    """Run a command in the MongoDB pod, capturing stdout. Mirrors
    runner.compose_exec_capture, including its (1, "") on failure."""
    res = kube.run(["kubectl", "--context", context, "-n", kubens.namespace_for(name), "exec",
               f"{MONGO_SERVICE}-0", "-c", "mongod", "--", *argv],
              timeout=timeout or APPLY_TIMEOUT, own=vocab.is_ours(context))
    return res.returncode, (res.stdout or "")

def exec_to_file(name: str, argv: list[str], dest: Path, *, context: str,
                 timeout: float | None = None) -> tuple[int, str]:
    """Run a command in the MongoDB pod, writing its RAW stdout to `dest`.

    Binary-safe, and that is the whole point: `mongodump --archive` emits BSON, and
    a text-mode decode would corrupt it silently -- the dump would restore with
    errors nobody could trace back here. So stdout goes straight to the file handle
    and never through Python's text layer.

    `kubectl exec` without `-t`, deliberately: a TTY translates newlines and would
    do the same damage from the other end.
    """
    argv_full = ["kubectl", "--context", context, "-n", kubens.namespace_for(name), "exec",
                 f"{MONGO_SERVICE}-0", "-c", "mongod", "--", *argv]
    try:
        with dest.open("wb") as handle:
            proc = subprocess.run(argv_full, stdout=handle, stderr=subprocess.PIPE,
                                  timeout=timeout or INSTALL_TIMEOUT, check=False,
                                  env=kubeexec.env_for(context))
        return proc.returncode, (proc.stderr or b"").decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)

def exec_from_file(name: str, argv: list[str], src: Path, *, context: str,
                   timeout: float | None = None) -> tuple[int, str]:
    """Run a command in the MongoDB pod with `src` piped to its stdin.

    `-i` is required and easy to forget: without it kubectl closes stdin
    immediately and `mongorestore --archive` reads an empty archive, reports
    success, and restores nothing at all.
    """
    argv_full = ["kubectl", "--context", context, "-n", kubens.namespace_for(name), "exec",
                 "-i", f"{MONGO_SERVICE}-0", "-c", "mongod", "--", *argv]
    try:
        with src.open("rb") as handle:
            proc = subprocess.run(argv_full, stdin=handle,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  timeout=timeout or INSTALL_TIMEOUT, check=False,
                                  env=kubeexec.env_for(context))
        return proc.returncode, (proc.stdout or b"").decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)
