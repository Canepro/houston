"""`houston.services.lifecycle.naming`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
import pytest


def test_sanitize_and_derive():
    assert lc.sanitize("RC 8.5.1!!") == "rc-8-5-1"
    assert lc.derive_name("8.5.1", "default") == "rc8-5-1"
    assert lc.derive_name("8.5.1", "ldap") == "rc8-5-1-ldap"
    assert lc.sanitize("...") == ""      # no usable chars -> empty (caller rejects)


# --- per-user naming (#team-auth) --------------------------------------------------
#
# On a shared server the second person to run `up -v 8.5.1` silently REUSED the
# first person's workspace, data and all. That is a data-loss bug independent of
# anything else here.

def test_two_people_running_the_same_version_get_two_workspaces():
    assert lc.derive_name("8.5.1", "default") == "rc8-5-1"          # unchanged solo
    assert lc.derive_name("8.5.1", "default", "alice") == "alice-rc8-5-1"
    assert lc.derive_name("8.5.1", "default", "bob") == "bob-rc8-5-1"
    assert lc.derive_name("8.5.1", "ldap", "alice") == "alice-rc8-5-1-ldap"


def test_an_explicit_name_is_namespaced_too():
    """Two people typing `--name test` collide exactly as derived names did."""
    assert lc.owner_prefix("test", "alice") == "alice-test"
    assert lc.owner_prefix("test", "bob") == "bob-test"
    # Idempotent, so `up --name alice-test` does not become alice-alice-test.
    assert lc.owner_prefix("alice-test", "alice") == "alice-test"


def test_naming_is_unchanged_without_an_actor():
    """A single-user machine must keep every existing workspace name."""
    assert lc.derive_name("8.5.1", "default", "") == "rc8-5-1"
    assert lc.owner_prefix("test", "") == "test"


def test_a_derived_name_stays_a_valid_dns_label():
    """It becomes a hostname under the front door, so dots would break the TLS
    wildcard silently."""
    name = lc.derive_name("8.5.1", "default", "alice")
    assert "." not in name and name == lc.sanitize(name)


def test_repro_names_are_length_capped():
    """Unbounded, the name passed validation and then raised ENAMETOOLONG from the
    filesystem -- a 500 from the web API and a raw traceback from the CLI."""
    from houston.services import lifecycle as lc
    lc._require_valid_name("a" * lc.NAME_MAX)          # at the limit: fine
    with pytest.raises(errors.ValidationError, match="limit is"):
        lc._require_valid_name("a" * (lc.NAME_MAX + 1))


def test_set_state_explains_a_downed_repro(monkeypatch):
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.engine, "start", lambda n: 1)
    monkeypatch.setattr(lc.runner.queries, "rc_state", lambda n: "absent")
    with pytest.raises(errors.DockerError) as exc:
        lc.set_state("x", "start")
    # `compose start` cannot revive a repro with no containers -- say what does.
    assert "no containers to start" in str(exc.value)


def test_use_resolves_the_name_like_every_other_command(monkeypatch, tmp_path):
    """`use` called `runner.exists()` on the literal argument.

    So `use TICKET-1234` failed on a workspace really named `ticket-1234` while
    `info --name TICKET-1234` found it -- and `name_candidates()`'s docstring is
    written about exactly that defect and says it was fixed. `use` was missed. On a box
    with accounts the owner-prefix half bites too: `up --name test` makes `alice-test`,
    and `use test` could not find it. Exit was 1, where the table says 4.
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list = []
    monkeypatch.setattr(lc.naming, "resolve_name",
                        lambda n: seen.append(n) or "ticket-1234")

    res = CliRunner().invoke(cli.app, ["use", "TICKET-1234"])
    assert res.exit_code == 0, res.output
    assert seen == ["TICKET-1234"], "use did not go through resolve_name"
    assert "ticket-1234" in res.output, res.output
    from houston import config
    assert config.load_config().get("default_repro") == "ticket-1234"

    # And an unknown name exits 4, not 1.
    def missing(n):
        from houston.errors import NotFoundError
        raise NotFoundError(f"no repro named {n!r}")
    monkeypatch.setattr(lc.naming, "resolve_name", missing)
    res = CliRunner().invoke(cli.app, ["use", "nope"])
    assert res.exit_code == 4, (res.exit_code, res.output)


def test_resolve_name_never_returns_a_path_that_escapes_the_repro_dir(tmp_path, monkeypatch):
    """The candidates are either already-legal names or sanitize() output, so a
    traversal cannot survive to become runner.workspace()."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import lifecycle as lcsvc

    for bad in ("../../etc", "a/b", "..", "./x", "x/../../y"):
        for cand in lcsvc.name_candidates(bad, actor="alice"):
            assert "/" not in cand and ".." not in cand, cand


def test_a_name_round_trips_through_create_and_resolve(tmp_path, monkeypatch):
    """The README's own first example: `up --name TICKET-1234` then
    `down --name TICKET-1234`. Creation sanitizes; resolution has to agree."""
    import dataclasses
    import json

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import runner
    from houston.services import lifecycle as lcsvc

    for typed, actor in (("TICKET-1234", ""), ("test", "alice"), ("TICKET-1234", "alice")):
        req = lcsvc.CreateReq(version="8.5.1", name=typed, actor=actor)
        made = lcsvc._derive_for(req)
        ws = runner.workspace(made)
        ws.mkdir(parents=True, exist_ok=True)
        f = {x.name: "" for x in dataclasses.fields(runner.Metadata)}
        f.update(name=made, project="houston-" + made, rc_version="8.5.1",
                 mongo_tag="8.0", host_port=3000, preset="default",
                 root_url="http://localhost:3000", extra={})
        (ws / "repro.json").write_text(json.dumps(dataclasses.asdict(runner.Metadata(**f))))
        (ws / "docker-compose.yml").write_text("services: {}\n")
        assert lcsvc.resolve_name(typed, actor=actor) == made, (typed, actor, made)
        # and the full name still resolves to itself, never double-prefixed
        assert lcsvc.resolve_name(made, actor=actor) == made
