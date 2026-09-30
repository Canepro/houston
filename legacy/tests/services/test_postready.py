"""`houston.services.postready`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from servicehelpers import _idp_meta
import pytest


def test_a_preset_configures_itself_through_the_runtime_that_owns_it(monkeypatch):
    """`no configuration file provided: not found` in the middle of a Kubernetes
    create, followed by "starting".

    That is docker compose's own wording for "there is no compose project here", and
    it appeared because a post_ready handler -- a preset configuring ITSELF -- called
    `runner.compose_exec` on a Kubernetes workspace. Presets exist on both runtimes
    now, so the one call that reaches into a container had to stop being a Compose
    call.
    """
    from houston.services import postready, topology

    m = postready.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)

    monkeypatch.setattr(postready.runner.engine, "compose_exec",
                        lambda *a, **kw: pytest.fail("it reached for docker compose"))
    from houston.services import k8s
    seen = []

    class _R:
        returncode, stdout, stderr = 0, "keycloak-abc", ""

    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: (seen.append(argv), _R())[1])
    assert postready._exec_in(m, "keycloak", ["bash", "-lc", "true"]) == 0
    assert any("kubectl" in a for argv in seen for a in argv), seen
    assert any("exec" in argv for argv in seen), seen

    # A Compose workspace must still go the other way -- this is a fork, not a swap.
    c = postready.runner.Metadata(name="c", project="houston-c", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3001, version_source="t")
    monkeypatch.setattr(postready.runner.engine, "compose_exec", lambda *a, **kw: 0)
    monkeypatch.setattr(k8s.kube, "run",
                        lambda *a, **kw: pytest.fail("it reached for kubectl"))
    assert postready._exec_in(c, "keycloak", ["true"]) == 0


def test_a_half_configured_preset_says_so_instead_of_reporting_success():
    """The create printed "could not fetch/apply IdP cert", then "starting", and
    left the reader to work out whether SAML actually worked.

    The DEPLOYMENT succeeding and the CONFIGURATION succeeding are different answers
    to different questions, and a workspace that is running with a half-applied
    preset has to say which one it is -- naming what failed and the command that
    retries it.
    """
    from houston.services import postready

    m = postready.runner.Metadata(name="w", project="p", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3000, version_source="t")
    m.extra["post_ready"] = [{"action": "saml_idp_cert"},
                             {"action": "keycloak_master_ssl_off"}]
    said: list = []
    postready._POST_READY_ACTIONS["saml_idp_cert"] = lambda *a, **kw: False
    postready._POST_READY_ACTIONS["keycloak_master_ssl_off"] = lambda *a, **kw: True
    try:
        failed = postready.run_post_ready(m, object(), lambda e: said.append(e.message))
    finally:
        import importlib
        importlib.reload(postready)

    assert failed == ["saml_idp_cert"], failed
    joined = " ".join(said)
    assert "RUNNING" in joined and "partly configured" in joined, joined
    assert "saml_idp_cert" in joined, joined
    assert "houston ready --name w" in joined, joined


def test_the_idp_cert_is_fetched_once_not_retried_around_a_retrier(monkeypatch):
    """A SAML create that sat for THIRTY MINUTES, found by the operational audit.

    `rcapi.fetch_saml_idp_cert` retries to its own deadline -- its docstring says
    "Retries until the IdP (e.g. Keycloak, which boots slowly) is serving" -- and
    v0.54.1 wrapped it in a second 20-attempt loop without reading that. 20 x 90s is
    half an hour of a create that looks hung and cannot be told from one that is.

    The deadline is passed IN instead, so there is one place that decides how long to
    wait.
    """

    from houston.services import postready

    src = source_of(postready._pr_saml_idp_cert)
    # The CALL, not the prose: the comment above it names the function to explain
    # why it is only called once, so counting the name counts the explanation too.
    assert src.count("rcapi.fetch_saml_idp_cert(") == 1, src
    assert "for attempt in range" not in src, "no loop around a function that loops"
    assert "timeout=IDP_CERT_DEADLINE" in src, src

    calls = []
    monkeypatch.setattr(postready.rcapi, "fetch_saml_idp_cert",
                        lambda url, **kw: (calls.append(kw), "")[1])
    postready._pr_saml_idp_cert(
        postready.runner.Metadata(name="w", project="p", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3000, version_source="t"),
        object(), {"descriptor_url": "http://localhost:8081/x", "setting": "s"},
        lambda e: None)
    assert len(calls) == 1, calls
    assert calls[0].get("timeout") == postready.IDP_CERT_DEADLINE, calls


def test_every_post_ready_handler_reports_a_boolean(monkeypatch):
    """The collection reads `is False`, so a handler that returns None opts itself
    out of it silently. Two did, and one of them was the oidc preset's only action.

    Enforced on the signatures rather than by calling them: a handler added later
    with `-> None` is the same bug again, and nothing else would catch it.
    """
    import inspect

    from houston.services import postready

    for name, fn in postready._POST_READY_ACTIONS.items():
        ret = inspect.signature(fn).return_annotation
        assert ret == "bool", f"{name} is annotated {ret!r}, not bool"
        src = source_of(fn)
        assert "return False" in src, f"{name} has no failure path to report"
        assert "return True" in src, f"{name} never reports success"


def test_an_oidc_provider_that_did_not_configure_is_reported_as_a_failure(monkeypatch):
    """The oidc preset's only self-config action could not be reported as failed.

    `run_post_ready` collects a failure on an explicit False, and this handler
    returned None on EVERY path -- so a workspace whose OAuth provider could not be
    created printed one warning, was left out of the "only partly configured"
    summary that exists for exactly this, and exited 0.
    """
    from houston.services import postready

    monkeypatch.setattr(postready.rcapi, "add_oauth_service", lambda *a, **kw: False)
    said: list = []
    m = _idp_meta()
    m.extra["post_ready"] = [{"action": "create_oauth_provider", "name": "Keycloak",
                              "settings": {"a": 1}}]
    failed = postready.run_post_ready(m, object(), lambda e: said.append(e.message))
    assert failed == ["create_oauth_provider"], failed
    joined = " ".join(said)
    assert "partly configured" in joined, joined


def test_a_provider_created_without_its_settings_is_not_a_success(monkeypatch):
    """Creating the provider is not the same as the provider working.

    The settings carry the realm URL, the client id and the secret. Every
    `set_setting` result was discarded, so a provider created with none of them
    reported "login button registered" -- and the button really was registered,
    pointing at nothing. That is what a support engineer sees as "I click the OIDC
    button and the page is blank".
    """
    from houston.services import postready

    monkeypatch.setattr(postready.rcapi, "add_oauth_service", lambda *a, **kw: True)
    monkeypatch.setattr(postready.time, "sleep", lambda s: None)
    # The url is the one that matters, and it is the one that refuses.
    monkeypatch.setattr(postready.rcapi, "set_setting",
                        lambda url, auth, pw, sid, val: "-url" not in sid)
    said: list = []
    settings = {"Accounts_OAuth_Custom-Keycloak": True,
                "Accounts_OAuth_Custom-Keycloak-url": "http://keycloak:8085/realms/x"}
    m = _idp_meta()
    m.extra["post_ready"] = [{"action": "create_oauth_provider", "name": "Keycloak",
                              "settings": settings}]
    failed = postready.run_post_ready(m, object(), lambda e: said.append(e.message))
    assert failed == ["create_oauth_provider"], failed
    joined = " ".join(said)
    assert "-url" in joined, "name the setting that did not apply"
    assert "lead nowhere" in joined, joined
    # And the happy path stays a success, or the fix would just refuse everything.
    monkeypatch.setattr(postready.rcapi, "set_setting", lambda *a, **kw: True)
    said.clear()
    assert postready.run_post_ready(m, object(), lambda e: said.append(e.message)) == []
