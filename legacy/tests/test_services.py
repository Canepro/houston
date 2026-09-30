"""Unit tests for the service layer (pure; no Docker).

These lock in the behaviour both the CLI and the web API depend on: naming,
error typing/HTTP mapping, port validation, and the event model.
"""

from __future__ import annotations


# --- the two-flag HTTPS surface (#https-domain-email) ---------------------------

def test_up_offers_exactly_two_https_flags():
    """The official compose asks for DOMAIN and LETSENCRYPT_EMAIL; so do we.

    This grew to nine visible flags across three certificate modes, which is the
    complaint that prompted the rewrite. The removed ones must be gone from the
    signature, not merely hidden -- an unreachable code path behind a deleted flag
    is worse than either.
    """
    import inspect
    from houston.cli import up as up_cmd
    params = set(inspect.signature(up_cmd).parameters)
    assert {"domain", "email", "https"} <= params
    for dead in ("tls_cert", "tls_key", "tls_san", "acme_staging",
                 "acme_email", "acme_challenge", "acme_dns_provider"):
        assert dead not in params, f"--{dead.replace('_', '-')} should be gone"


def test_a_workspace_whose_database_is_gone_is_not_reported_healthy(monkeypatch, tmp_path):
    """Rocket.Chat serves /api/info with NO DATABASE behind it.

    Measured on a live workspace: `docker stop <mongodb>`, then /api/info 200, login
    000 after 15s, `ready` exit 0 "ready", `list` running, `detail()` state=running
    health=healthy uptime="2 minutes" -- and the same payload's containers array
    holding ("mongodb", "exited"). The summary contradicted its own detail. Every
    remediation the tool then offered pointed back at `ready`: `api` exits 5 with
    "wait for it with `houston ready`" and `seed` exits 1 with the same, and `ready`
    reports success. There was no exit from that loop without reading `docker ps`.

    `degraded_reason` is one rule, consulted by the list, the panel and `ready`, so
    they cannot drift -- the same remedy `repro_state()` needed when the list and the
    panel disagreed about state.
    """
    from houston.services.lifecycle import ESSENTIAL_SERVICES, degraded_reason

    healthy = {"mongodb": "Up 2 hours", "rocketchat": "Up 2 hours (healthy)"}
    dead_db = {"mongodb": "Exited (0) 3 minutes ago",
               "rocketchat": "Up 2 hours (healthy)"}

    assert degraded_reason(healthy) == ""
    assert degraded_reason(dead_db) == "mongodb is exited", degraded_reason(dead_db)
    # A workspace with no mongodb container at all (Kubernetes, or an external Mongo)
    # is not evidence of a fault -- absence is not the same as stopped.
    assert degraded_reason({"rocketchat": "Up 2 hours (healthy)"}) == ""
    # SIDE SERVICES ARE NOT ESSENTIAL. A stopped Mailpit is something a person lives
    # with; treating every preset sidecar as fatal would refuse workspaces that work.
    assert "mailpit" not in ESSENTIAL_SERVICES
    assert degraded_reason({"mongodb": "Up 1 hour", "mailpit": "Exited (1) ago"}) == ""


def test_ending_a_session_that_had_already_ended_is_not_a_success(monkeypatch, tmp_path):
    """`revoke_sid` returns False when the sid is not in the store, and the route
    answered `{"ok": true, "ended": 1}` regardless.

    Reachable as a race: a session can expire between the `list_for` lookup and the
    revoke. A sign-out that revoked nothing should not report that it did.
    """

    # Through the ROUTE. This read `houston/web/app.py` whole, which stopped containing
    # the handler in phase 2a -- and reading a whole file is why it took a `build_app`
    # branch and a helper to express at all. DELETE, because GET /api/sessions is a
    # different function and matching the path alone would check the wrong one.
    from conftest import source_of_route

    assert "if not sessions.revoke_sid(" in source_of_route("/api/sessions", "DELETE"), (
        "a failed session revoke is still reported as success")


def _terminal_event_offenders(ast, calls_to, dones, paths, waits):
    """Every function in these modules judged against the rule, both directions."""
    # THE TWO DIRECTIONS ARE ASKED AT DIFFERENT SCOPES, on purpose.
    #
    # "handed off, so something must finish" is a claim about a PATH: 2b.15 left
    # `_pull_and_recreate` handing off and the `done` one step later in
    # `_confirm_the_upgrade`, which is correct and which a per-function read called a
    # defect. So a hand-off may be answered by the step that calls it.
    #
    # "already announced, so do not announce again" stays per-function, because
    # flattening it mixes branches that cannot both run: `_pull_and_recreate` rolls
    # back on failure, and the rollback's own final `wait_and_finalize` is not on the
    # path that reaches the success `done`.
    for path in paths:
        tree = ast.parse(path.read_text())
        steps = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        for fn in tree.body:
            if not isinstance(fn, ast.FunctionDef):
                continue
            seen = waits(fn)
            if not seen:
                continue
            where = f"{path.name}::{fn.name}"
            after = max(line for line, _handed in seen)
            later = [d for d in dones(fn) if d > after]
            def finished_after(caller, at):
                    """Does `caller` announce the end after line `at`?

                    Directly, or by calling a step that does -- `_run_locked` calls
                    `_pull_and_recreate` and then `_confirm_the_upgrade`, and the
                    `done` is in the second of those.
                    """
                    if any(d > at for d in dones(caller)):
                        return True
                    return any(dones(steps[name])
                               for name in steps
                               if any(c > at for c in calls_to(caller, name)))

            if any(handed for _line, handed in seen):
                answered = bool(later) or any(
                    any(finished_after(caller, c) for c in calls_to(caller, fn.name))
                    for caller in steps.values() if caller is not fn)
                assert answered, (
                    f"{where}: passes final=False and nothing after it -- here or in "
                    "the step that calls it -- emits `done`")
            else:
                # The same reach, and only to DIRECT callers. Transitively, `run`
                # reaches `rollback`'s own final wait through the failure path of
                # `_pull_and_recreate` and then the success `done` -- two branches that
                # cannot both run, which read as a double announcement. One step out is
                # the orchestrator that really does run both in order.
                doubled = bool(later) or any(
                    any(finished_after(caller, c) for c in calls_to(caller, fn.name))
                    for caller in steps.values() if caller is not fn)
                assert not doubled, (
                    f"{where}: announces the end and then something after it does too "
                    "— pass final=False")


def _terminal_event_readers(ast):
    """The three reads this walk needs: the waits, the `done`s, and who calls whom."""
    def waits(fn):
        """(line, handed_off) for each `wait_and_finalize` call in this function."""
        return [(n.lineno, any(k.arg == "final" and k.value.value is False
                               for k in n.keywords))
                for n in ast.walk(fn) if isinstance(n, ast.Call)
                and (getattr(n.func, "attr", "") == "wait_and_finalize"
                     or getattr(n.func, "id", "") == "wait_and_finalize")]

    def dones(fn):
        return [n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call)
                and getattr(n.func, "id", "") in ("info", "warn")
                and any(k.arg == "phase" and getattr(k.value, "value", "") == "done"
                        for k in n.keywords)]

    def calls_to(caller, name):
        return [n.lineno for n in ast.walk(caller) if isinstance(n, ast.Call)
                and (getattr(n.func, "attr", "") or getattr(n.func, "id", "")) == name]
    return calls_to, dones, waits


def test_every_caller_that_keeps_working_hands_off_the_terminal_event():
    """The half of the rule a unit test cannot see: which call sites pass `final=False`.

    Read from the source because it is a property OF the call sites. A caller that
    goes on working must not have announced the end, and -- the failure that this is
    really guarding -- a caller that has no later `done` must not hand it off either,
    or the run ends with no terminal event at all. Both directions have been wrong in
    this file within one change.
    """
    import ast
    import pathlib

    # The lifecycle PACKAGE plus the two modules beside it. This named `lifecycle.py`
    # in a directory, which phase 2b turned into `lifecycle/` -- and a filename in a
    # walk is the one thing a split reliably breaks.
    import houston
    services = pathlib.Path(next(iter(houston.__path__))) / "services"
    paths = sorted((services / "lifecycle").rglob("*.py"))
    paths += [services / "upgrade.py", services / "backup.py"]
    calls_to, dones, waits = _terminal_event_readers(ast)

    _terminal_event_offenders(ast, calls_to, dones, paths, waits)
