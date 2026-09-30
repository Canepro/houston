"""The row model, the id vocabulary, and the one way to add a row to a report.

`run_checks` used to be a single 1,044-line function with a rolling `subject`
variable and a nested `line()` closure, and both properties were load-bearing: a
`line()` added inside a block could not forget its id, and every status of one check
shared an id, so an agent watching `ports` saw the ok and the warn on one key.
Splitting the function into one module per subject removes the rolling variable, so
`subject` becomes an explicit argument -- which is the same guarantee said out loud.

**`CHECKS` is a published contract**, the machine-readable half of `doctor --json`. A
caller watches an ID; the message beside it is prose and may be reworded in any release.
One id per SUBJECT, not per outcome: deriving the id from the message instead -- the
obvious shortcut -- gives `port-3000-free` when it passes and `port-3000-in` when it
does not, which is two ids for one check and a watcher that never sees the state it was
watching for.

This module imports nothing from `houston.services.doctor`. It cannot: every check
module imports it, and importing a submodule runs the package initialiser first, so a
reach back up here would be a cycle (see `checks/__init__.py`).
"""
from __future__ import annotations

from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any

#: One row of the report. A plain dict, deliberately: it is serialised verbatim into
#: `doctor --json` and read by `app.js`, so a class here would be a second shape to keep
#: in step with the first.
Row = dict


#: Every check id `run_checks` can report, in report order.
CHECKS: tuple[str, ...] = (
    "preflight",                    # the report itself could not be assembled
    "docker", "compose", "engine-kernel", "hub-auth",
    "disk", "memory", "swap",
    "version-lookup", "ports",
    "edge", "edge-routes-stale", "edge-routes-unreachable",
    "gui-accounts", "gui-admin", "gui-roles", "gui-create-policy",
    "state-file-perms", "home-perms", "home-writable", "sessions-file", "identity",
    "kubernetes", "kubernetes-tools", "kubernetes-cluster",
    "kubernetes-storage", "kubernetes-ingress", "kubernetes-loadbalancer",
    "kubernetes-metrics", "kubernetes-other-clusters", "inotify",
    "kubernetes-cert-manager", "kubernetes-edge-port", "kubernetes-chart-repo",
    "kubernetes-https", "kubernetes-helm-reach", "kubernetes-cloud",
    "kubernetes-skew", "kubernetes-cloud-owned",
    "install-fresh", "edge-config-drift", "preset-browser-host",
    "interrupted-work", "event-log", "legacy-artifacts",
)


@dataclass
class Ctx:
    """What one check needs from the run, and what it may hand to the next.

    Deliberately small. Four values crossed a block boundary in the original
    function and these are those four: the cluster being reported on, whether Docker
    answered, and the two AWS futures started before the local checks so the slowest
    thing in the report -- measured at 1,783ms of a 2,485ms run -- finishes while they
    run. Anything else a check needs, it asks for itself.
    """

    #: The cluster to report on, defaulting to the box's `kubernetes.context`.
    context: str = ""
    #: Whether the Docker daemon answered. Set by the `docker` check, read by
    #: `engine-kernel`, `edge` and the repro tally.
    docker_up: bool = False
    #: `aws.preflight()` and `eks.remembered()`, started early and read by `kubernetes`.
    cloud: Future | None = None
    owned: Future | None = None


@dataclass
class Report:
    """The rows one check produced, and the only way to add one."""

    rows: list[Row] = field(default_factory=list)

    def line(self, subject: str, status: str, msg: str, elsewhere: str = "",
             check: str = "") -> None:
        """Add a row. `subject` is the check id unless `check=` overrides it.

        `elsewhere` names a place the GUI shows this fact PERMANENTLY. The web report
        drops those rows (see the `/api/doctor` endpoint): a terminal has no header
        chip, no user list and no workspace rail, so `houston doctor` is the only place
        a CLI user learns them and they stay; in the browser they were a report
        restating what was already on the screen. Only ever set on an `ok` row -- a
        WARNING about the same subject is not something the chip beside it says, and
        those all still appear.
        """
        cid = check or subject
        # Declared, not free-form: these are published by `doctor --json` as a
        # contract, and a typo would be a check that silently stops being watchable.
        #
        # NOT AN `assert`. Asserts are stripped under `python -O`, so the guard would
        # vanish exactly where a mis-declared id becomes unnoticeable -- and unstripped
        # it raised AssertionError out of `GET /api/doctor`, which is a 500 and directly
        # contradicts this report's own rule that a check must never break it. Falls
        # back to the `preflight` id, which exists for "the report itself could not be
        # assembled", and says so in the row rather than in a traceback.
        if cid not in CHECKS:
            self.rows.append({"check": "preflight", "status": "warn",
                              "message": f"internal: check id {cid!r} is not in "
                                         f"doctor.CHECKS, so this row is unwatchable — "
                                         f"{msg}"})
            return
        row: dict[str, Any] = {"check": cid, "status": status, "message": msg}
        if elsewhere:
            row["elsewhere"] = elsewhere
        self.rows.append(row)
