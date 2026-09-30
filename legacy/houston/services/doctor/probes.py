"""The measurements `doctor` makes that other code also needs.

Three of these are public API with callers outside the report: `mongo_kernel_conflict`
is spent by the create preflight, by the GUI's version lookup and by the CLI, and
`inotify_headroom` by the Kubernetes capacity path. They are here rather than in the
package initialiser for the same reason `rows.py` is: every check module imports them,
and importing a submodule runs the initialiser first, so a reach back up would be a
cycle. `houston.services.doctor` re-exports all three.
"""
from __future__ import annotations

import os
import re

from houston import runner
from houston.services.mongo_kernel import MONGO8_BAD_KERNEL as MONGO8_BAD_KERNEL
from houston.services.mongo_kernel import _kernel_major_minor as _kernel_major_minor
from houston.services.mongo_kernel import mongo_kernel_conflict as _mongo_kernel_conflict


def _major_version(version: str | None) -> int | None:
    """Leading integer of a version string ('v2.29.1' -> 2, '5.3.1' -> 5), or None.

    Comparing only the first CHARACTER (`...[:1] == "2"`) reported every Compose
    release newer than v2 as unsupported — v5 is current — and would misread a
    future v10 as v1.
    """
    m = re.match(r"v?(\d+)", (version or "").strip())
    return int(m.group(1)) if m else None


def mongo_kernel_conflict(mongo_tag: str, kernel: str | None = None) -> str:
    """Why this MongoDB cannot start on this engine, or "" if it can.

    SERVER-121912: mongod 8.0 hard-EXITS on kernel >= 6.19. Not degrades -- exits,
    every time, with a message that reads like a volume or permission problem. So
    there is no case where continuing works, which is what makes this a refusal
    rather than a warning (the same reasoning as `check_capacity`).

    Version-aware on purpose. `run_checks()` below can only warn generically,
    because `doctor` does not know which release you are about to boot; by the
    time a create has resolved its pairing, the answer is exact -- RC 8.6.1 needs
    Mongo 8.0 and therefore cannot start here, while RC 7.4.1 needs 7.0 and can.

    One implementation, three callers: the create preflight refuses with it, the
    GUI's version lookup shows it before you press the button, and the CLI gets
    it for free by going through the service. It was two copies with different
    behaviour -- a generic warn here and a version-aware warn inlined in
    web/app.py -- and neither of them stopped the pull.
    """
    measured = kernel if kernel is not None else runner.docker_kernel_version()
    return _mongo_kernel_conflict(mongo_tag, measured)


INOTIFY_PER_CLUSTER = 60


def inotify_in_use(proc: str = "/proc") -> int | None:
    """How many inotify instances this UID already holds, or None if unknowable.

    Counted rather than modelled, because modelling is what made this check useless:
    see `inotify_headroom`. Only fds this user may read are visible -- the limit is
    per-UID and container watchers run as root -- so a number here is a FLOOR, never
    the whole picture, and the caller must not present it as one.
    """
    try:
        uid = os.getuid()
        pids = [d for d in os.listdir(proc) if d.isdigit()]
    except (OSError, AttributeError):
        return None
    total = 0
    for pid in pids:
        base = f"{proc}/{pid}"
        try:
            if os.stat(base).st_uid != uid:
                continue
            for fd in os.listdir(f"{base}/fd"):
                try:
                    if os.readlink(f"{base}/fd/{fd}") == "anon_inode:inotify":
                        total += 1
                except OSError:
                    continue
        except OSError:
            continue                      # the process went away, or is not ours
    return total


def inotify_headroom(clusters: int = 1, path: str = "/proc/sys/fs/inotify/max_user_instances",
                     in_use: int | None = None) -> list[tuple[str, str]]:
    """Whether the kernel will let another watcher start.

    This check exists because the symptom points nowhere near the cause. With
    `fs.inotify.max_user_instances` exhausted, Traefik starts, stays up, logs
    `Cannot start the provider *file.Provider ... too many open files`, and then
    serves its OWN default certificate to every request -- which looks exactly like
    a broken route or a bad certificate, and is neither. It cost three full runs to
    find, and kind's own documentation raises these limits for multi-cluster use.

    **It also used to pass while that was happening.** `in_use` was a parameter the
    body never read: the check compared the LIMIT against a modelled
    `clusters * INOTIFY_PER_CLUSTER` and never against consumption. So on a box whose
    128 instances were already spoken for by Docker, k3s, MetalLB, cert-manager and the
    edge, it printed a green tick -- "inotify instances: 128 (~60 needed here)" -- while
    Traefik was failing with EMFILE and loading no dynamic configuration at all.
    Measured during the HTTPS work, which is the exact scenario the docstring above was
    written about. A model cannot see the other consumers; only a count can.

    So consumption is read when it can be read, and the verdict is about what is LEFT
    rather than about the ceiling. What can be read is a floor -- the limit is per-UID
    and containers run as root -- so a comfortable-looking margin is reported without
    the word that would make it a promise.

    Linux-only by construction: the file does not exist elsewhere, and a missing
    file is silence rather than a warning about a limit that does not apply.
    """
    try:
        with open(path) as fh:
            limit = int(fh.read().strip())
    except (OSError, ValueError):
        return []
    need = max(1, clusters) * INOTIFY_PER_CLUSTER
    used = inotify_in_use() if in_use is None else in_use
    free = limit if used is None else max(0, limit - used)
    seen = "" if used is None else f", {used} already in use by this user"
    # Three tiers, all on what is LEFT rather than on the ceiling. The old order asked
    # `limit >= need` after this, which meant the `fail` tier could not be reached once
    # consumption was subtracted -- a box with no room at all would have been reported
    # as merely tight.
    if free < need:
        return [("fail", f"inotify instances: {limit}{seen} — about {free} left for the "
                         f"~{need} that {max(1, clusters)} cluster(s) want. Traefik will "
                         f"start, load NO dynamic configuration and serve its own "
                         f"default certificate, which looks like a broken route rather "
                         f"than a kernel limit. `sudo sysctl -w "
                         f"fs.inotify.max_user_instances=1024`")]
    if free < need * 2:
        return [("warn", f"inotify instances: {limit}{seen} — about {free} left against "
                         f"the ~{need} wanted, which is tight. A watcher that cannot "
                         f"start makes Traefik serve its own default certificate. "
                         f"`sudo sysctl -w fs.inotify.max_user_instances=1024`")]
    return [("ok", f"inotify instances: {limit}{seen} (kind and Traefik watch files; "
                   f"~{need} needed here)")]
