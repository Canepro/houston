"""`houston.scaleseed`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import scaleseed


def test_clearing_a_bulk_seed_also_removes_what_rc_repro_seeded():
    """The scale tag is stamped into the WORKSPACE's own MongoDB, which is the one
    leftover a rename cannot reach by moving a directory.

    Documents inserted before the rename carry `rcrepro_scale` for as long as that
    database exists. Matching only the new tag would leave a bulk seed permanently
    unremovable -- the single thing `--clear` exists to do -- and it would fail
    silently, reporting zero deletions with nothing to say why. Pre-fix the generated
    script names only `houston_scale`.
    """
    import inspect


    js = inspect.getsource(scaleseed.clear)
    # The behavioural claim FIRST, so this fails on the behaviour against the pre-fix
    # code rather than on a constant that did not exist yet.
    assert "_LEGACY_SCALE_TAG" in js, (
        "`clear` names only the current tag, so anything seeded before the rename "
        "cannot be removed by the command that exists to remove it")
    assert "rcrepro_scale" in scaleseed._LEGACY_SCALE_TAG
    # every destructive statement uses the combined match, not the bare new tag
    for stmt in ("db['users'].deleteMany(", "db['rocketchat_message'].deleteMany("):
        at = js.index(stmt)
        rest = js[at + len(stmt):]
        assert rest.startswith("{match_either}"), f"{stmt} still matches one tag: {rest[:40]}"


def test_parse_scale_room_ref_cannot_reach_the_js_unquoted(monkeypatch):
    # This used to assert on the stdlib's repr() and never touch scaleseed at all,
    # so the guard it was named for had no coverage. Exercise both layers: the
    # _SPEC_RE whitelist (the real guard) and the quoted interpolation.
    captured = {}
    monkeypatch.setattr(scaleseed, "_eval",
                        lambda name, js: captured.setdefault("js", js) or (0, '{"inserted": 1}'))
    scaleseed.bulk_messages("x", 1, "team-chat")
    assert "'team-chat'" in captured["js"]          # only ever inside a JS literal
    for bad in ("ev'il", 'ev"il', "ev\\il", "ev\nil", "a b", "a;b", "$where"):
        try:
            scaleseed.parse_scale(f"messages=1@{bad}")
        except ValueError:
            continue
        raise AssertionError(f"_SPEC_RE should reject room {bad!r}")


def test_scaleseed_does_not_rerun_a_partially_applied_script(monkeypatch):
    shells = []

    def killed_midway(_name, _service, args, **_kw):
        shells.append(args[0])
        return 137, '{"inserted": 400000}'      # OOM-killed after committing batches

    monkeypatch.setattr(scaleseed.runner.engine, "compose_exec_capture", killed_midway)
    rc, _out = scaleseed._eval("x", "print(1)")
    # Falling through to `mongo` would re-run a non-idempotent insertMany and
    # duplicate every batch already written.
    assert rc == 137 and shells == ["mongosh"]

    shells.clear()

    def binary_missing(_name, _service, args, **_kw):
        shells.append(args[0])
        return 127, ""                          # never started, no output

    monkeypatch.setattr(scaleseed.runner.engine, "compose_exec_capture", binary_missing)
    scaleseed._eval("x", "print(1)")
    assert shells == ["mongosh", "mongo"]       # the legacy fallback still applies


def test_parse_scale_rejects_ambiguous_and_oversized_specs():
    for bad in ("users=10@team-chat",             # a room means nothing for users
                "messages=10@a,messages=20@b",    # silently last-wins before
                "users=1,users=2",
                f"users={scaleseed._MAX_DOCS + 1}"):
        try:
            scaleseed.parse_scale(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")
    assert scaleseed.parse_scale("users=10,messages=20@general") == {
        "users": 10, "messages": (20, "general")}


# --- data-scale prefill (--scale) ---------------------------------------------


def test_parse_scale_users_and_messages():
    assert scaleseed.parse_scale("users=50000,messages=800000@team-chat") == {
        "users": 50000, "messages": (800000, "team-chat")}


def test_parse_scale_users_only():
    assert scaleseed.parse_scale("users=100") == {"users": 100}


def test_parse_scale_messages_without_room_raises():
    for bad in ("messages=100", "users=abc", "foo=1"):
        try:
            scaleseed.parse_scale(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {bad!r}")
