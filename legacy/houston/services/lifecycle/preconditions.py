"""What has to be true before a command runs at all.

Tier 1. Each of these REFUSES rather than warning: an engine that is not there, a state
transition that is not defined, a teardown the caller may not perform, a project name
already taken by something houston did not create. A create that starts and then cannot
finish leaves a half-made workspace, which is worse than never starting.
"""
from __future__ import annotations

import shutil
import sys

from houston import presets, runner
from houston.errors import (ConflictError, DockerError, PreflightError, ValidationError)
from houston.services import audit as auditsvc
from houston.services import topology
from houston.services.lifecycle import naming, ownership
from houston.services.lifecycle.types import (STATE_ACTIONS, _KUBERNETES_UNSUPPORTED,
                                              _LOOPBACK_BINDS, CreateReq)


def _require_the_compose_plugin():
    """A box can have the engine without the plugin, and `docker info` says nothing about it."""
    # AND the compose plugin, because every path here shells out to `docker compose`
    # and a box can have one without the other. Reported from a fresh Amazon Linux EC2
    # instance where `docker ps` worked and `houston up` died with docker's own
    # unhelpful pair:
    #
    #     docker: 'compose' is not a docker command.
    #     unknown shorthand flag: 'd' in -d
    #
    # `docker_available()` runs `docker info`, which says nothing about the plugin, so
    # the engine looked fine and the failure arrived from the middle of a create. It is
    # a preflight fault -- fix your environment -- so it is raised as one, once, with
    # the package to install.
    cv = runner.compose_version()
    major = cv.split(".")[0].lstrip("v") if cv else ""
    if not major.isdigit() or int(major) < 2:
        if cv:
            raise PreflightError(
                f"`docker compose` reports {cv}, and houston needs v2 or newer. "
                "Upgrade the compose plugin, then `docker compose version`.")
        # NOT NECESSARILY ABSENT. The same binary is both the plugin and a standalone
        # `docker-compose`, so a box can have a working v2 on PATH while
        # `docker compose` does not exist -- the binary was never put where the docker
        # CLI looks. Seen on EC2, and "install the plugin" is the wrong instruction
        # there: it is installed, just not registered.
        standalone = runner.compose_standalone_version()
        if standalone:
            raise PreflightError(
                f"`docker compose` is not available, but a standalone "
                f"`docker-compose` {standalone} is on PATH — the binary is there and the "
                f"docker CLI cannot see it as a plugin. houston calls `docker compose`, "
                f"so register it once:\n"
                f"    mkdir -p ~/.docker/cli-plugins\n"
                f"    ln -sf \"$(command -v docker-compose)\" "
                f"~/.docker/cli-plugins/docker-compose\n"
                f"  Then `docker compose version` should print {standalone}.")
        raise PreflightError(
            "`docker compose` v2 is not available — the plugin is not installed. "
            "Everything houston does with containers goes through it."
            "\n  Amazon Linux / RHEL / Fedora: `sudo dnf install -y docker-compose-plugin`"
            "\n  Debian / Ubuntu:              `sudo apt-get install -y docker-compose-plugin`"
            "\n  Then `docker compose version`, and `houston doctor` to check the rest.")


def require_docker() -> None:
    """Refuse when the container engine is not answering.

    `DockerError`, not `NotReadyError`. The distinction is the whole point of the
    exit-code taxonomy: `NOT_READY` (exit 5, HTTP 409) means "it is coming up,
    poll again", and an absent engine is never that -- polling cannot start
    Docker. It is a preflight problem the caller must fix, so `ENGINE_UNAVAILABLE`
    (exit 3, HTTP 502): the dependency this tool sits on is not there.

    It matters more once a second topology exists: "the engine is not answering"
    will cover a missing cluster and an unreachable API server too, and those are
    the same kind of answer -- fix your environment -- not the same kind as a
    workspace that has not finished booting.
    """
    if not runner.docker_available():
        # Named for the platform, because "Start Docker Desktop" on Linux names a
        # product that is usually not the one installed -- and a reader who cannot
        # find the thing the error names tends to doubt the error, not the wording.
        starter = ("Start Docker Desktop" if sys.platform in ("darwin", "win32")
                   else "Start it with `sudo systemctl start docker`")
        raise DockerError(f"Docker isn't running. {starter} and try again.")
    _require_the_compose_plugin()


def unsupported_fields(runtime: str) -> list[dict]:
    """What a runtime cannot honour, from the registry the create path enforces.

    Published so the create dialog can say it BEFORE somebody fills a field in --
    and, more to the point, so it cannot say it wrongly. The list has shrunk twice
    while the GUI's own copy of it would not have: `--reg-token` and every preset
    were on it until they were built. Two places deciding the same thing is how a
    form ends up refusing something that works, which is worse than not mentioning
    it at all.
    """
    from houston.services import topology
    if topology.normalize(runtime) != topology.KUBERNETES:
        return []
    return [{"field": name, "why": why} for name, why in _KUBERNETES_UNSUPPORTED]


def require_engine(target: str) -> None:
    """Require the engine THIS workspace runs on -- not the one Compose needs.

    `require_docker()` was called before anything looked at the runtime, so every
    Kubernetes path went through a gate it has no use for. On a host with no Docker
    at all -- which is the documented adopt-an-existing-cluster setup -- `upgrade`,
    `upgrade --rollback`, `ready`, `logs`, `token`, `api`, `pat`, `seed` and `down`
    all refused a perfectly healthy workspace with "Docker isn't running".

    `teardown` is the sharpest case: it dispatches on the runtime *inside* itself,
    under a comment about a workspace that "could be CREATED and never removed" --
    and the gate three lines above defeated that dispatch entirely.

    Three modules already got this right and said so in comments (`backup.py`,
    `monitor.py`, and `envvars.py`, which refuses Kubernetes outright rather than
    dispatching). Nobody generalised it, so each new call site started from the
    Compose assumption again. This is that generalisation; the inline versions in
    those three predate it and do the same thing.

    CONTRACT: `target` is an already-resolved workspace name. `resolve_name` reads
    repro.json and asks no engine anything, so resolving first costs nothing and is
    what makes a runtime-aware gate possible at all.
    """
    if topology.of_repro(target) != topology.KUBERNETES:
        require_docker()
        return
    # kubectl is the engine here. Said rather than assumed: without it every
    # Kubernetes operation fails one layer deeper, in a subprocess whose "command
    # not found" names nothing the reader can act on.
    if not shutil.which("kubectl"):
        raise PreflightError(
            f"{target!r} runs on Kubernetes and `kubectl` is not on PATH, so "
            f"houston cannot reach it. Install kubectl and make sure your "
            f"kubeconfig points at the cluster this workspace lives in.")


def reachable_beyond_loopback(*, tlsspec=None, bind_host: str = "") -> bool:
    """Whether anything off this machine can reach this workspace.

    This is the ONE question `config.ADMIN_PASSWORD` turns on.
    `config.DEFAULT_BIND_HOST`'s own comment states the threat model: loopback is
    WHY a fixed weak credential is acceptable at all. Both ways of removing that
    premise are here, and they are genuinely different mechanisms -- a public name
    reaches Rocket.Chat through the edge while the workspace itself stays on
    loopback, so the bind check alone answers "no" for the very case that matters
    most, which is exactly how `--domain` came to be created in silence.

    A LOCAL-CA `--https` name is deliberately NOT public: `<name>.houston.localhost`
    resolves to 127.0.0.1, nothing off the box can reach it, and treating it as
    exposed would rotate the password for the common local case for no gain.
    """
    from houston import tls as _tlsmod          # lazy, as everywhere else here
    if tlsspec is not None and getattr(tlsspec, "mode", "") == _tlsmod.MODE_ACME:
        return True
    return bind_host not in _LOOPBACK_BINDS


def _guard_project_collision(name: str) -> None:
    """Refuse to create when a docker compose project of the same derived name
    already exists but belongs to a DIFFERENT workspace.

    The project name is `houston-<name>` regardless of HOUSTON_HOME, so a repro
    named after an existing one in another home would make `docker compose up`
    reconcile (hijack) the other workspace's containers/volume. Best-effort: if
    docker can't be queried, skip the check rather than block."""
    existing = runner.project_config_files()
    if not existing:
        return
    proj = runner.project_name(name)
    if proj not in existing:
        return
    ours = str(runner.workspace(name) / "docker-compose.yml")
    files = existing[proj]
    if ours not in files:
        raise ConflictError(
            f"a docker compose project {proj!r} already exists, owned by a different "
            f"workspace ({files or 'unknown'}). Creating {name!r} here would hijack its "
            "containers and data volume - choose a different --name.")


def check_state_request(name: str, action: object) -> str:
    """Refuse a bad stop/start/restart BEFORE any work is queued. Returns the target.

    A PREFLIGHT, in the sense v0.70.9 established for namespace ownership: a refusal
    must leave no trace. The GUI runs this as a job now, and a job answers 200 with an
    id -- so a bad action or an unknown name would have become a job that failed rather
    than a 400 or a 404 on the request that made the mistake. The checks are pure
    argument validation and cost nothing, so they stay on the request thread; only the
    work is queued.
    """
    if not isinstance(action, str):
        raise ValidationError(f"action must be a string (want "
                              f"{'|'.join(STATE_ACTIONS)}), got {type(action).__name__}")
    if action not in STATE_ACTIONS:
        raise ValidationError(f"unknown action {action!r} "
                              f"(want {'|'.join(STATE_ACTIONS)})")
    return naming.resolve_name(name)


def check_teardown_request(name: str, *, volumes: bool = False,
                           confirm: bool = False) -> str:
    """Refuse an unconfirmed or unowned teardown before it is queued. Returns the target.

    Same reason as `check_state_request`, and the stake is higher: without it a member
    who asked to destroy a colleague's workspace got 200 and a job id, and had to open
    the Activity list to discover they had been refused. The refusal belongs on the
    request. `teardown` repeats both checks, because the CLI calls it directly and a
    guard that only one front-end performs is not a guard.
    """
    target = naming.resolve_name(name)
    if volumes and not confirm:
        raise ValidationError(f"deleting {target!r}'s data volume and record is "
                              "irreversible - pass confirm=true")
    if volumes:
        allowed, why = ownership.may_destroy(target, auditsvc.actor())
        if not allowed:
            auditsvc.record("down-volumes", target, outcome="denied")
            raise ConflictError(why)
    return target


def _refuse_unsupported_on_kubernetes(req: CreateReq) -> None:
    """Refuse what this runtime cannot honour, rather than accepting and dropping it.

    Ordered so the most consequential is reported first when several are set: being
    told about `--fresh` matters more than being told about `--reg-token`, because
    one of them is about data.
    """
    for name, why in _KUBERNETES_UNSUPPORTED:
        if getattr(req, name, None):
            raise ValidationError(
                f"--{name.replace('_', '-')} is not supported on Kubernetes yet: "
                f"{why}. Use --runtime docker for a workspace that needs it.")
    # A preset reaches Kubernetes when it has an adapter for it -- the Scenario
    # contract from #3. Those that do not are still refused, because being recorded
    # and not applied is what this guard exists to prevent; but the refusal is now
    # per preset rather than a blanket "not supported", and it names the ones that
    # DO work so the answer is actionable.
    if req.preset and req.preset != "default":
        works = ", ".join(sorted(presets.scenario_names())) or "none yet"
        try:
            resolved_preset = presets.resolve(req.preset, topology.KUBERNETES,
                                              req.params or {})
        except ValueError as exc:
            raise ValidationError(
                f"preset {req.preset!r} cannot be resolved for Kubernetes: {exc}. "
                f"Presets with a Kubernetes adapter: {works}. Or use "
                f"--runtime docker, where every preset works.") from exc
        # RESOLVING is not the same as WORKING. A preset with no scenario adapter
        # comes back with its Compose `services` intact -- Keycloak, Mailpit, MinIO
        # -- and this runtime builds no compose document, so those containers would
        # simply never exist while the settings pointing at them were applied. That
        # is the silent-drop shape again, one level further in: the workspace boots,
        # the preset is recorded, and the scenario it names is not there.
        if resolved_preset.services and not resolved_preset.kubernetes_manifests:
            raise ValidationError(
                f"preset {req.preset!r} needs backing services "
                f"({', '.join(sorted(resolved_preset.services))}) and has no "
                f"Kubernetes adapter to create them, so they would be missing while "
                f"Rocket.Chat was configured to use them. Presets with an adapter: "
                f"{works}. Or use --runtime docker, where every preset works.")
