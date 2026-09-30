"""`houston.services.lifecycle.create_docker`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import call_order
from conftest import source_index
from conftest import source_of
from houston.services import lifecycle as lc
from servicehelpers import _capture_create


def test_the_edge_attaches_after_the_workspace_is_up_not_before(tmp_path, monkeypatch):
    """Attaching needs the network `docker compose up` has only just created.
    Registering during the build wrote a correct route to a backend the edge
    could not resolve, so the name answered 502 -- and a 502 is not an error
    anyone sees, it just looks like a broken workspace."""

    from houston.services import lifecycle as lc

    # The step that owns both. They were adjacent in one 503-line function; they are
    # adjacent in a 26-line one now, and keeping them in the same step is what makes
    # the ordering claim expressible at all.
    up_at, attach_at = call_order(lc.create_docker._start_the_workspace, "_up", "attach")
    assert attach_at > up_at, "attach must come after the workspace is up"


def test_the_kubernetes_refusals_are_reached_from_the_create_path():
    """Wired at the dispatch, not merely defined. A guard nothing calls is worse
    than no guard, because the docstring says it is handled."""

    src = source_of(lc._create_repro_locked)
    call = source_index(src, "_refuse_unsupported_on_kubernetes")
    dispatch = source_index(src, "_create_kubernetes(req")
    assert call < dispatch, "the refusal must run BEFORE the workspace is built"


def test_the_requested_bind_is_read_in_one_place():
    """The derivation gates on the bind and the create publishes on it. Two spellings
    of `req.bind or cfg or default` is how they come to disagree about one workspace --
    and the disagreement would be silent, because each is right on its own."""

    from houston.services import lifecycle as lc

    # The whole create MODULE, not one function of it: the create is a plan and a
    # sequence of steps now, and "read in one place" is a claim about the module.
    src = source_of(lc.create_docker)
    assert "_requested_bind_host(" in src, src[:200]
    assert 'req.bind or cfg.get("bind_host")' not in src, \
        "the bind expression was inlined again; call _requested_bind_host"


def test_a_refused_create_leaves_no_note_behind(monkeypatch, tmp_path):
    """The write-ahead note is for a create that died HALF WAY, not one that never
    started.

    `record` then `_create_repro_locked` then `clear`, with no try/finally, so ANY
    refusal stranded the note -- a bad version, a taken port, the capacity preflight, a
    namespace-ownership check, a Kubernetes-unsupported flag -- one per attempt. Seven
    accumulated during the audit, three of them for the same never-created name. Worse
    than untidy: `doctor` then warns "the create started at ... never finished ...
    `houston ready --name X` completes it", and that command exits 4 NOT_FOUND. On a
    CLI-only box nothing ever clears them, because recovery runs at `serve` startup and
    `doctor` reports without repairing.
    """
    from houston.errors import ValidationError
    from houston.services import journal
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.create_docker, "_create_repro_locked",
                        lambda *a, **k: (_ for _ in ()).throw(
                            ValidationError("--https is not supported on kubernetes")))

    before = len(journal.open_entries())
    try:
        lc.create_repro(lc.CreateReq(version="8.5.1", name="refu"))
    except ValidationError:
        pass
    else:
        raise AssertionError("the refusal did not propagate")

    after = journal.open_entries()
    assert len(after) == before, (
        f"a refused create left {len(after) - before} note(s): "
        f"{[e.kind + ':' + e.workspace for e in after]}")


def test_an_explicitly_wide_bind_is_warned_about(monkeypatch, tmp_path):
    """`--bind 0.0.0.0` published fixed weak credentials and said nothing.

    The exposure warning fired only on `req.bind_public`, which houston sets ITSELF
    when it widens the bind for an ACME challenge -- so the derived case was announced
    and the case a person deliberately asked for was silent. Verified from the box's
    own LAN address: /api/info 200, and POST /api/v1/login with admin/admin123
    returning a full admin authToken, after an `up` that printed the normal panel with
    a URL reading `http://localhost:<port>`.

    `config.DEFAULT_BIND_HOST`'s comment states this threat model exactly and
    `errors.GATE_PUBLIC_EXPOSURE` was declared for it. The opt-in is deliberate and
    stays; being quiet about it was an omission, not a decision.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc.create_docker)
    # The derived branch, and the ASKED-FOR branch beside it.
    assert "req.bind_public and plan.bind_host not in" in src
    assert "elif plan.bind_host not in _LOOPBACK_BINDS:" in src, (
        "an explicitly requested wide bind still has no warning branch")
    after = src.split("elif plan.bind_host not in _LOOPBACK_BINDS:", 1)[1][:2600]
    # The WARNING ITSELF, not the block around it. The comments there record the
    # defect this branch was written for and quote the old credential by name, so a
    # naive substring search over the block reports the history as if it were the
    # message -- which is how this assertion first failed against a correct fix.
    said = after.split('warn(plan.emit,', 1)[1].split('phase="create")', 1)[0]
    for expected in ("trusted network", "--bind", "every interface"):
        assert expected in said, f"the wide-bind warning does not mention {expected!r}"
    # The CREDENTIALS half is deliberately no longer here. The Rocket.Chat admin is
    # generated for a bind this wide and printed on the panel two lines below, so
    # saying it again was a sentence people scroll past -- and a warning nobody reads
    # costs the NEXT warning its reader. What survives is what the panel does not
    # say: the preset's own UI, Grafana, and seeded users, each named only when the
    # create actually has one.
    assert "admin123" not in said, (
        "the panel prints the real password; repeating a wrong one is worse than "
        f"silent:\n{said}")
    assert "seeded users, whose password is their username" in after, (
        "the credential that is STILL weak must survive the trim")
    assert "req.seed" in after, "and be said only when there are seeded users"


def test_a_loopback_workspace_keeps_the_shared_password(monkeypatch):
    """Nothing off this box can reach it, which is the entire reason `admin123` is
    acceptable. Rotating it here would cost every runbook and buy nothing."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="loop", wait=False),
                    emit=lc.null_emit)
    assert seen["meta"].admin_password == "", "empty means the shared default"
    assert seen["meta"].admin_pass == config.ADMIN_PASSWORD
    assert "admin123" in seen["yaml"]


def test_binding_wide_generates_one_too(monkeypatch):
    """`--bind 0.0.0.0` removes the same premise by the other mechanism, and the
    bind path is the one that already warned -- so it must not be the one left
    handing `admin123` to the LAN."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="wide", wait=False,
                                 bind="0.0.0.0"), emit=lc.null_emit)
    assert seen["meta"].admin_password != ""
