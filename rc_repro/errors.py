"""Domain errors shared by the CLI and the web API.

The CLI historically failed by calling `ui.die()` (which raises `typer.Exit`) at
~75 sites. That is fine for a one-shot process but fatal for a long-lived server:
a single bad request would exit the whole thing. The service layer instead raises
these, and each front-end translates them:

    CLI  ->  except ReproError as e: _fail(e)        # red line + e.exit_code
    API  ->  except ReproError as e: HTTP e.http_status

One taxonomy, three consumers. `http_status` lets the web layer map each cause to
the right status code without the service layer importing anything web-specific;
`exit_code` does the same for the CLI so a script or agent can tell "not ready
yet" from "known dead" without parsing text; `code` is the stable identifier a
machine-readable payload reports, so callers branch on it rather than on prose.

`code` values are stable API. Renaming one is a breaking change; the message
attached to an exception is not stable and may be reworded freely.
"""

from __future__ import annotations


class ReproError(Exception):
    """Base for all expected, user-facing failures.

    Subclasses set `code` (stable identifier), `exit_code` (CLI process exit),
    and `http_status` (web API). The base itself is the catch-all for an expected
    failure with no more specific cause.
    """
    http_status = 400
    code = "REPRO_ERROR"
    exit_code = 1

    def __init__(self, message: str = "", *, code: str | None = None,
                 details: dict | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code
        self.details = dict(details or {})


class ValidationError(ReproError):
    """Bad input (port range, name, unknown --set param, bad version/preset)."""
    http_status = 400
    code = "VALIDATION_FAILED"
    exit_code = 2      # usage error: fix the call, retrying unchanged won't help


class ConflictError(ReproError):
    """A resource is already taken (host port / repro name / monitoring slot)."""
    http_status = 409
    code = "CONFLICT"
    exit_code = 8      # pick another name/port and retry


class NotFoundError(ReproError):
    """No such repro / default repro missing."""
    http_status = 404
    code = "NOT_FOUND"
    exit_code = 4


class MissingRecordError(NotFoundError, FileNotFoundError):
    """A workspace directory with no readable `repro.json`.

    BOTH BASES, deliberately. As a `NotFoundError` it carries `http_status = 404`,
    so `serve` answers a half-written workspace with the documented status instead
    of a 500 and a traceback -- `detail()` and `describe()` run on the request
    thread, and a bare `FileNotFoundError` escaped the whole error contract.

    As a `FileNotFoundError` it is still what a dozen callers already catch. Those
    handlers are correct -- "this workspace has no record" genuinely is the thing
    they mean to skip -- and rewriting each of them to catch a new type would have
    been a wide change with one silent miss enough to turn a skip into a crash.
    """


class NotReadyError(ReproError):
    """Docker is down, or Rocket.Chat isn't serving / can't be logged into."""
    http_status = 409
    code = "NOT_READY"
    exit_code = 5      # still unknown: the caller may poll again


class DockerError(ReproError):
    """A `docker`/`docker compose` invocation failed."""
    http_status = 502
    code = "ENGINE_UNAVAILABLE"
    exit_code = 3      # preflight/engine problem: run `rc-repro doctor`


class PreflightError(ReproError):
    """Environment or capacity preflight refused the request (exit 3).

    Distinct from ValidationError (bad caller input) and DockerError (engine
    unreachable for compose). Capacity shortfalls and unsupported resize paths
    use this so they never masquerade as a successful preflight.
    """
    http_status = 409
    code = "PREFLIGHT_FAILED"
    exit_code = 3


class CreateFailedError(ReproError):
    """A create hit a condition that cannot self-heal, so waiting is pointless.

    Distinct from NotReadyError on purpose: 5 means "still unknown, the clock ran
    out", 7 means "known dead, stop now". Collapsing them is what makes callers
    wait out a run that had already failed.
    """
    http_status = 500
    code = "CREATE_FAILED"
    exit_code = 7


class AuthorityGateError(ReproError):
    """An action needs a human decision rc-repro is not authorised to make.

    Public exposure, an unapproved cluster, new credentials, deleting something
    rc-repro does not own, retaining a run. Never retryable and never
    auto-approvable: `approve_with` is what to ask a human to run, not something
    the caller may run itself.
    """
    http_status = 403
    code = "GATE"
    exit_code = 6
    #: ADVERTISED, because this build raises it: `lifecycle.py` refuses to copy the
    #: local CA private key into a cluster that is not on this machine. The flag was
    #: False with the instruction "set this True in the same commit that adds the
    #: first raise, not before" -- and that commit landed without doing so, which
    #: made the flag itself the defect: `capabilities` omitted every gate while one
    #: was reachable, so a caller branching on `code` met one it was never told about.
    #: The reverse of the failure the flag was added to prevent, by the same
    #: mechanism.
    advertised = True

    def __init__(self, message: str, *, kind: str = "", subject: str = "",
                 approve_with: str = "", code: str | None = None,
                 details: dict | None = None) -> None:
        super().__init__(message, code=code, details=details)
        self.kind = kind                  # e.g. "cluster", "retention"
        self.subject = subject            # what the gate is about
        self.approve_with = approve_with  # exact command for a human to run

    def as_gate(self) -> dict:
        """The gate as a plain dict, for a machine-readable error payload."""
        out = {"kind": self.kind, "subject": self.subject,
               "approve_with": self.approve_with}
        if self.details:
            out["details"] = dict(self.details)
        return out


#: Every authority gate rc-repro can raise, declared rather than invented at the
#: call site. AuthorityGateError takes its code as an argument, so without this
#: registry the published error-code set could only advertise the base "GATE" and a
#: caller could not know what to expect. Adding a gate means adding it here, which
#: is the point: a gate a caller cannot anticipate is one it cannot handle.
GATE_CODES: dict[str, str] = {
    "GATE_NOT_ONBOARDED": "rc-repro has not been onboarded on this machine",
    "GATE_OWNED_CLUSTER": "the rc-repro-owned local cluster was not authorised",
    "GATE_ENGINE_RESIZE": "resizing the container engine was not authorised",
    "GATE_UNAPPROVED_CLUSTER": "the target Kubernetes cluster is not an approved one",
    "GATE_DELETE_UNOWNED": "the resource was not created by rc-repro",
    "GATE_PUBLIC_EXPOSURE": "the request would expose a repro beyond loopback",
    "GATE_RETENTION": "retaining this run was not authorised",
    # DISTINCT from GATE_UNAPPROVED_CLUSTER, which already means "the CA private key
    # may not go there". Giving one code two meanings breaks the premise jsonout rests
    # on -- that a caller branches on `code` -- and these two want opposite responses:
    # one is about a secret leaving this box, the other about money leaving an account.
    "GATE_CLOUD_SPEND": "creating a cluster that costs money was not authorised",
}


#: The gate codes this build can actually PRODUCE, as opposed to the ones it knows
#: about. `GATE_CODES` above is the registry and most of it is unreachable; publishing
#: all of it is the exact failure `_error_codes()` exists to prevent -- a caller
#: writing a branch that never runs. Advertising only the base "GATE" is the opposite
#: failure, because the base is not what arrives: a gate carries its specific code,
#: so a caller told to expect "GATE" and handed "GATE_UNAPPROVED_CLUSTER" cannot
#: branch at all.
#:
#: Written out rather than derived, because deriving it means walking the source for
#: `code=` literals at import time. `tests/test_json.py` does exactly that walk and
#: asserts this tuple matches, so it cannot drift without the suite saying so.
RAISED_GATE_CODES: tuple[str, ...] = ("GATE_UNAPPROVED_CLUSTER", "GATE_CLOUD_SPEND",
                                      "GATE_DELETE_UNOWNED")


def as_payload(exc: ReproError) -> dict:
    """A failure as a machine-readable dict, for any front-end that speaks JSON.

    This module's docstring promises that `code` is "the stable identifier a
    machine-readable payload reports, so callers branch on it rather than on
    prose". It was a promise nothing kept: the web layer answered
    `{"error": ..., "kind": "<ClassName>"}`, and a Python class name is not a
    stable identifier -- renaming a class is a refactor, renaming a `code` is a
    breaking change. A caller branching on `kind` was branching on the one field
    nobody had agreed not to move.

    `kind` is still emitted, because it costs nothing and something may already
    read it. New callers should use `code`.

    `AuthorityGateError` gets its gate inlined. `as_gate()` was written "for a
    machine-readable error payload" and had no caller at all, so the one thing a
    gate exists to communicate -- `approve_with`, the exact command for a human to
    run -- never left the process.
    """
    body = {"error": str(exc), "code": exc.code, "kind": type(exc).__name__}
    if isinstance(exc, AuthorityGateError):
        body["gate"] = exc.as_gate()
    elif getattr(exc, "details", None):
        body["details"] = dict(exc.details)
    return body


#: Every exit code this taxonomy can produce, with a short machine-readable
#: label. Front-ends publish this rather than hardcoding the numbers, so the map
#: has exactly one definition.
EXIT_CODES: dict[int, str] = {
    0: "ok",
    1: "internal",
    2: "usage",
    3: "preflight",
    4: "not_found",
    5: "not_ready",
    6: "gate",
    7: "create_failed",
    8: "conflict",
}
