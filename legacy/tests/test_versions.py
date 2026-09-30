"""`houston.versions`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import versions


def test_a_never_released_version_is_not_resolved_silently():
    """`versions 99.99.99` exited 0 with a confident pairing.

    `_resolve_online` returned None for ANY non-200 -- a 404 from a reachable endpoint
    and an unreachable endpoint alike -- so a typo fell through to the curated map,
    matched a rule for the series, and produced a clean answer for a release that does
    not exist. `8.5.1-rc.1` did the same. A caller who gets that then spends ten
    minutes on a failing image pull.
    """

    res = versions.resolve("99.99.99")
    assert res.mongo_tag, "no pairing at all would be a different bug"
    assert res.source == "map (no such release)", res.source
    assert "has no 99.99.99" in res.note, res.note
    # An OFFLINE resolve cannot have asked, so it must not claim the release is absent.
    off = versions.resolve("99.99.99", offline=True)
    assert off.source == "map (fallback)", off.source
    assert "has no" not in off.note, off.note


def test_the_compatible_mongo_note_says_which_end_it_took():
    """`_highest` picks the newest compatible MongoDB, and for a support reproduction
    the interesting one is usually the customer's -- which for an older Rocket.Chat is
    usually the OLDEST supported.

    RC 4.8.7 offers 3.6,4.0,4.2,4.4,5.0: the live lookup resolves 5.0 while the shipped
    versions.yaml rule gives 4.4 with the note "needs MONGO_OPLOG_URL". So `up -v 4.8.7`
    and `up -v 4.8.7 --offline` pair a different MongoDB MAJOR, and one of them changes
    whether the oplog path is exercised at all. Which end was taken is said now; which
    end is CHOSEN is unchanged, because changing it would repair one class of
    reproduction and break another.
    """

    assert versions._lowest(["3.6", "4.0", "4.4", "5.0"]) == "3.6"
    assert versions._highest(["3.6", "4.0", "4.4", "5.0"]) == "5.0"
    # Unparseable tags are skipped rather than crashing the lookup.
    assert versions._lowest(["latest", "4.4"]) == "4.4"
    assert versions._lowest([]) is None


def test_a_mongo_override_must_be_an_image_tag():
    """`--mongo` is templated into a Kubernetes StatefulSet by f-string, so a value
    carrying a newline added its own YAML keys and `kubectl apply` accepted them.

    Refused at the boundary rather than escaped at the template: this is the one
    place a caller-supplied tag enters, both runtimes read `resolved.mongo_tag`
    afterwards, and a value that is not an OCI tag cannot name a real image anyway.
    """
    import dataclasses

    import pytest

    from houston.errors import ValidationError

    fields = {f.name: (f.default if f.default is not dataclasses.MISSING else "")
              for f in dataclasses.fields(versions.Resolved)}
    fields.update(rc_version="7.4.1", rc_image="i", mongo_tag="7.0",
                  mongo_flavor="official")
    resolved = versions.Resolved(**fields)

    for bad in ("8.0\n        privileged: true", "8.0 --privileged", "-8.0", "",
                "a" * 129, "8.0\n"):
        with pytest.raises(ValidationError, match="not a MongoDB image tag"):
            versions.apply_mongo_override(resolved, bad)
    assert resolved.mongo_tag == "7.0", "a refused override must not be applied"

    # The tags this tool actually pairs, including the flavor split at Mongo 8.
    versions.apply_mongo_override(resolved, "8.0")
    assert (resolved.mongo_tag, resolved.mongo_flavor) == ("8.0", "official")
    versions.apply_mongo_override(resolved, "6.0.5-ubi8")
    assert (resolved.mongo_tag, resolved.mongo_flavor) == ("6.0.5-ubi8", "bitnami-legacy")


def test_a_version_the_index_has_never_heard_of_is_named_before_the_build(
        monkeypatch, tmp_path):
    """`resolve()` stamps `source="map (no such release)"` when releases.rocket.chat
    answered 404, and the create path ignored it -- so `up --version 99.99.99` built
    the whole compose document, created containers and failed ~90s later at docker's
    own "not found", leaving a workspace to clean up.

    Measured on EC2 against the real index. A warning rather than a refusal: the
    shipped map can legitimately pair a version the live index has not indexed yet.
    """
    from houston import versions
    from houston.services import lifecycle as lcsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    said: list[str] = []
    monkeypatch.setattr(lcsvc.runner.engine, "up", lambda *a, **k: 0)
    monkeypatch.setattr(lcsvc.runner.engine, "down", lambda *a, **k: 0)

    fields = {f.name: (f.default if f.default is not __import__("dataclasses").MISSING
                       else "") for f in __import__("dataclasses").fields(versions.Resolved)}
    fields.update(rc_version="99.99.99", rc_image="i", mongo_tag="8.0",
                  mongo_flavor="official", source="map (no such release)")
    monkeypatch.setattr(versions, "resolve", lambda *a, **kw: versions.Resolved(**fields))

    try:
        lcsvc.create_repro(lcsvc.CreateReq(version="99.99.99", name="bogus"),
                           emit=lambda e: said.append(e.message))
    except Exception:                      # noqa: BLE001 - the boot is not the subject
        pass
    assert any("has no 99.99.99" in m for m in said), said
    assert any("shipped map" in m for m in said), \
        "it must say where the pairing came from, not just that the version is unknown"

    # A version the index DOES know is not warned about.
    fields["source"] = "releases.rocket.chat"
    monkeypatch.setattr(versions, "resolve", lambda *a, **kw: versions.Resolved(**fields))
    said.clear()
    try:
        lcsvc.create_repro(lcsvc.CreateReq(version="8.5.1", name="fine"),
                           emit=lambda e: said.append(e.message))
    except Exception:                      # noqa: BLE001
        pass
    assert not [m for m in said if "has no" in m], said


# --- version resolution (offline / fallback map) ------------------------------


def test_resolve_rc8_official():
    r = versions.resolve("8.4.1", offline=True)
    assert r.mongo_flavor == "official"
    assert r.mongo_shell == "mongosh"
    assert r.oplog is False  # deprecated in 8.x
    assert r.rc_image.endswith("rocketchat/rocket.chat")


def test_resolve_rc7_bitnami_with_oplog():
    r = versions.resolve("7.10.13", offline=True)
    assert r.mongo_flavor == "bitnami-legacy"
    assert r.oplog is True


def test_resolve_rc4_legacy_shell():
    r = versions.resolve("4.8.0", offline=True)
    assert r.mongo_tag == "4.4"
    assert r.mongo_shell == "mongo"  # mongosh only ships in Mongo 5+


def test_resolve_bad_version_raises():
    try:
        versions.resolve("not-a-version", offline=True)
    except ValueError:
        return
    raise AssertionError("expected ValueError for a bad version")
