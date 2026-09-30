"""`houston.configimport`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from corehelpers import _dump
from houston import configimport


def test_configimport_redaction_requires_a_single_mask_alphabet():
    for masked in ("XXXXXXXX", "xxxx", "****", "######", "●●●●●●", "····"):
        assert configimport._is_redacted(masked), masked
    # A character class matched any MIXTURE, and "." inside [...] is a literal
    # dot -- so real dotted/mixed values were dropped from the import while being
    # reported to the operator as "the dump masked this secret".
    for real in ("....", "*.*.*.*", "x.x.x.x", "#.#.#", "Xx.#*", "1.2.3.4",
                 "a.b.c.d", "XXX"):
        assert not configimport._is_redacted(real), real


def test_a_bad_settings_file_is_a_validation_error_not_a_traceback(tmp_path):
    """A customer dump is exactly the file that arrives wrong.

    Truncated by a download, HTML from an expired share link, or the whole support
    bundle instead of the settings file inside it. `json.loads` raised a bare
    `json.JSONDecodeError`, which is not a `ReproError` -- so the CLI printed a
    traceback and the web layer answered 500, where every other bad input in this path
    says what is wrong with the file.
    """
    import json as _json

    from houston import configimport

    html = tmp_path / "customer-settings.json"
    html.write_text("<html><body>Link expired</body></html>")
    try:
        configimport.build_plan(html)
    except ValueError as exc:
        assert not isinstance(exc, _json.JSONDecodeError), (
            "still the raw decoder error, which no front-end handles")
        assert "customer-settings.json" in str(exc), str(exc)
        assert "not valid JSON" in str(exc), str(exc)
        assert "HTML" in str(exc), "the commonest cause is not mentioned"
    else:
        raise AssertionError("a non-JSON dump was accepted")

    # And the service layer turns it into the typed error both front-ends render.
    from houston.errors import ValidationError
    from houston.services import data as datasvc
    try:
        datasvc._build_plan(str(html), None)
    except ValidationError:
        pass
    else:
        raise AssertionError("services/data.py did not type the failure")


def test_config_import_keeps_only_customized(tmp_path):
    plan = configimport.build_plan(_dump(tmp_path, [
        {"_id": "A", "value": True, "packageValue": True},     # unchanged -> skip
        {"_id": "B", "value": "x", "packageValue": "y"},       # changed -> apply
    ]))
    assert plan.apply == [("B", "x")]


def test_config_import_skips_redacted(tmp_path):
    plan = configimport.build_plan(_dump(tmp_path, [
        {"_id": "SMTP_Password", "value": "XXXXXXXX", "packageValue": ""},
        {"_id": "Some_Secret", "value": "********", "packageValue": ""},
        {"_id": "Real", "value": "keep", "packageValue": ""},
    ]))
    assert [s for s, _ in plan.apply] == ["Real"]
    assert set(plan.redacted) == {"SMTP_Password", "Some_Secret"}


def test_config_import_denies_identity_settings(tmp_path):
    plan = configimport.build_plan(_dump(tmp_path, [
        {"_id": "Site_Url", "value": "https://cust", "packageValue": ""},
        {"_id": "Enterprise_License", "value": "RCV3_x", "packageValue": ""},
        {"_id": "Assets_logo", "value": {"url": "a"}, "packageValue": {}},
        {"_id": "Message_MaxAllowedSize", "value": 9000, "packageValue": 5000},
    ]))
    assert [s for s, _ in plan.apply] == ["Message_MaxAllowedSize"]
    assert set(plan.denied) == {"Site_Url", "Enterprise_License", "Assets_logo"}


def test_config_import_detects_oauth_providers(tmp_path):
    plan = configimport.build_plan(_dump(tmp_path, [
        {"_id": "Accounts_OAuth_Custom-Ms_entra_id", "value": True, "packageValue": False},
        {"_id": "Accounts_OAuth_Custom-Ms_entra_id-id", "value": "abc", "packageValue": ""},
    ]))
    assert plan.oauth_services == ["Ms_entra_id"]


def test_config_import_only_filter(tmp_path):
    items = [
        {"_id": "Livechat_title", "value": "T", "packageValue": ""},
        {"_id": "LDAP_Enable", "value": True, "packageValue": False},
    ]
    plan = configimport.build_plan(_dump(tmp_path, items), only={"Livechat"})
    assert [s for s, _ in plan.apply] == ["Livechat_title"]


def test_config_import_tolerates_malformed_entries(tmp_path):
    # a hand-edited dump: a bare string, a dict with a numeric _id, a dict with
    # no value — none should crash build_plan; the one good entry still applies.
    plan = configimport.build_plan(_dump(tmp_path, [
        "just a string",
        {"_id": 123, "value": "x", "packageValue": "y"},
        {"_id": "NoValue", "packageValue": "y"},
        {"_id": "Good", "value": "new", "packageValue": "old"},
    ]))
    assert [s for s, _ in plan.apply] == ["Good"]


def test_config_import_redaction_variants(tmp_path):
    plan = configimport.build_plan(_dump(tmp_path, [
        {"_id": "A", "value": "xxxxxxxx", "packageValue": ""},   # lowercase mask
        {"_id": "B", "value": "●●●●●●", "packageValue": ""},      # bullet mask
        {"_id": "C", "value": "########", "packageValue": ""},   # hash mask
        {"_id": "D", "value": "real-value", "packageValue": ""},  # legit
    ]))
    assert [s for s, _ in plan.apply] == ["D"]
    assert set(plan.redacted) == {"A", "B", "C"}


def test_config_import_rejects_non_list(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text('{"not": "a list"}')
    try:
        configimport.build_plan(p)
    except ValueError as exc:
        assert "list of settings" in str(exc)
    else:
        raise AssertionError("expected ValueError")
