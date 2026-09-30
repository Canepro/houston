"""`houston.services.lifecycle.types`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import edge as fd
from houston.services import lifecycle as lc
import pytest


def test_createreq_defaults():
    r = lc.CreateReq(version="8.5.1")
    assert r.preset == "default" and r.seed is False and r.params == {}
    # dataclass default_factory gives a fresh dict per instance
    lc.CreateReq(version="8.5.1").params["x"] = 1
    assert lc.CreateReq(version="8.5.1").params == {}


def test_createreq_carries_no_dead_tls_fields():
    """CreateReq is the web API's schema too, so a stale field is a stale endpoint."""
    fields = set(lc.CreateReq.__dataclass_fields__)
    for dead in ("tls_cert", "tls_key", "tls_san", "acme_challenge_given"):
        assert dead not in fields, f"CreateReq.{dead} should be gone"
    assert {"domain", "acme_email", "https", "acme_staging"} <= fields
    # These two survive as DERIVED state, not input: _pick_challenge sets them and
    # no flag reaches them.
    assert {"acme_challenge", "acme_dns_provider"} <= fields


def test_the_idp_host_is_taken_from_the_url_the_caller_already_gave():
    """`--root-url` and `--domain` are the caller saying "people will type this".

    The saml/oidc presets otherwise address their IdP as this machine, so a
    workspace created with a public URL shipped SSO that pointed at the visitor's own
    laptop -- and the only clue was a login page the browser bounced back to. Nothing
    had to be guessed: the address was on the request all along.
    """
    from houston.services import lifecycle as lc

    # `--bind` throughout: a host is only derived when the ports are published
    # somewhere it could answer. See
    # test_a_browser_host_is_only_derived_when_something_could_reach_it for why
    # deriving under the default loopback bind makes things worse rather than better.
    said: list = []
    req = lc.CreateReq(version="8.5.1", name="n", preset="saml", bind="0.0.0.0",
                       root_url="https://rc.example.com")
    lc._derive_idp_host(req, lambda e: said.append(e.message))
    assert req.params["idp_host"] == "rc.example.com", req.params
    assert "rc.example.com" in " ".join(said), "say it, rather than doing it silently"

    # A domain is the same statement in a different flag.
    dom = lc.CreateReq(version="8.5.1", name="n", preset="oidc", bind="0.0.0.0",
                       domain="sso.example.com")
    lc._derive_idp_host(dom)
    assert dom.params["idp_host"] == "sso.example.com", dom.params

    # Explicit always wins.
    mine = lc.CreateReq(version="8.5.1", name="n", preset="saml", bind="0.0.0.0",
                        root_url="https://rc.example.com", params={"idp_host": "other"})
    lc._derive_idp_host(mine)
    assert mine.params["idp_host"] == "other", mine.params

    # Nothing is invented for a plain local workspace, or for a preset with no IdP.
    for req in (lc.CreateReq(version="8.5.1", name="n", preset="saml"),
                lc.CreateReq(version="8.5.1", name="n", preset="saml", bind="0.0.0.0",
                             root_url="http://localhost:3001"),
                lc.CreateReq(version="8.5.1", name="n", preset="ldap", bind="0.0.0.0",
                             root_url="https://rc.example.com")):
        lc._derive_idp_host(req)
        assert not (req.params or {}).get("idp_host"), req.params


def test_webui_handles_every_state_the_backend_can_report():
    """Each state repro_state() can return must be styled and filterable.

    repro_state() stopped flattening docker's transitional states, so they now
    reach the dashboard for real. A state the UI does not know about renders with
    no colour and lands in renderDetail's fallback branch -- which did not exist
    until these became reachable.
    """
    import re
    from importlib import resources
    from houston.services import lifecycle as lc
    webui = resources.files("houston").joinpath("data", "webui")
    css = webui.joinpath("app.css").read_text(encoding="utf-8")
    html = webui.joinpath("index.html").read_text(encoding="utf-8")

    for state in ("running", "stopped", "down", "unknown") + lc.TRANSIENT_STATES:
        # The rail row's left gutter, and the word under it. Cards became rows in
        # the v4 redesign; the property this test protects did not change — a state
        # the interface does not know about renders with no colour at all.
        assert re.search(rf'\.wrow\[data-state="{state}"\]', css), \
            f"no rail accent for state {state!r}"
        assert re.search(rf"\.wstate\.{state}\b", css), f"no state colour for {state!r}"
        assert re.search(rf"\.pill\.{state}\b", css), f"no pill colour for state {state!r}"
    # …and each real one is reachable from the status filter.
    for state in lc.TRANSIENT_STATES:
        assert f'value="{state}"' in html, f"status filter cannot select {state!r}"


def test_the_lock_name_and_the_written_name_cannot_drift():
    """create_repro derives the name twice -- once to lock, once in the body. If
    they disagreed, the lock would guard a different repro than the one written."""
    for req in (lc.CreateReq(version="8.5.1", actor="alice"),
                lc.CreateReq(version="8.5.1", preset="ldap", actor="alice"),
                lc.CreateReq(version="8.5.1", name="My Repro!", actor="alice"),
                lc.CreateReq(version="8.5.1")):
        assert lc._derive_for(req) == lc._derive_for(req)
        assert lc._derive_for(req)


def test_a_domain_without_an_email_says_how_to_set_one(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import errors
    from houston.services import lifecycle as lcsvc

    req = lcsvc.CreateReq(version="8.5.1", domain="chat.example.com")
    with pytest.raises(errors.ValidationError) as exc:
        lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert "config set acme.email" in str(exc.value)


def test_the_cluster_is_privileged_and_both_callers_resolve_it_the_same_way(monkeypatch,
                                                                           tmp_path):
    """One resolver, because two callers disagreeing is a real failure.

    `_will_provision` decides whether `check_capacity` reserves a control plane's RAM;
    `_create_kubernetes` decides where the workspace actually goes. A default applied
    in one and not the other reserves memory for a kind cluster while building in EKS.
    """
    from houston import config

    assert "context" in lc.PRIVILEGED_CREATE_FIELDS, \
        "choosing the cluster is the same class of decision as rc_image and bind"

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert lc.req_context(lc.CreateReq(version="8.5.1")) == ""

    config.update_config(lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, "eks-support"))
    assert lc.req_context(lc.CreateReq(version="8.5.1")) == "eks-support", \
        "the box default applies to both front ends, not just the CLI"
    assert lc.req_context(lc.CreateReq(version="8.5.1", context="other")) == "other", \
        "an explicit --context still wins"


def _a_billable_cluster_with_no_domain(monkeypatch, tmp_path):
    """A cloud cluster that costs money and has no public name pointed at it."""
    from houston.services import k8s, lifecycle as lcmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # Reach the policy this test names without asking this machine whether it has
    # enough RAM, whether releases.rocket.chat answers, or whether kubectl/helm are
    # installed. Before these stubs, a network failure was caught by the broad
    # `except` below and the test misleadingly reported that the warning was absent.
    monkeypatch.setattr(lcmod.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lcmod.ports, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lcmod.versions, "resolve", lambda version, offline=False:
                        lcmod.versions.Resolved(version, "img", "8.0", "official", "mongosh", False, "test", ""))
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **kw: k8s.Preflight())
    seen: list = []

    def spy(ev):
        seen.append((ev.level, ev.message))

    def plan(dist):
        monkeypatch.setattr(k8s.context, "plan_cluster", lambda ctx="": k8s.ClusterPlan(
            context="the-cluster", distribution=dist, create=False))

    # A managed cluster and no name: warned.
    plan("eks")
    req = lcmod.CreateReq(version="8.5.1", runtime="kubernetes", context="the-cluster")
    try:
        lcmod._create_kubernetes(req, emit=spy)
    except Exception:  # noqa: BLE001 - it fails later; the warning is what is tested
        pass
    warned = [m for lvl, m in seen if lvl == "warn" and "--domain" in m]
    return lcmod, plan, seen, spy, warned


def test_a_billable_cluster_without_a_domain_warns_but_does_not_refuse(monkeypatch,
                                                                      tmp_path):
    """Warned, not refused, and the difference is the point.

    A refusal would remove the one way to reach a workspace whose ingress is broken —
    which is exactly when somebody needs a port-forward. But on a cluster billing by
    the hour, a port-forward is a poor thing to have paid for: tied to a pod, gone when
    it restarts, one machine at a time, and leaving the cluster's whole reason for
    being remote unused.
    """
    lcmod, plan, seen, spy, warned = _a_billable_cluster_with_no_domain(monkeypatch, tmp_path)
    assert warned, [m for _, m in seen]
    assert "port-forward" in warned[0] and "eks" in warned[0]

    # The same cluster WITH a name: nothing to say.
    seen.clear()
    req = lcmod.CreateReq(version="8.5.1", runtime="kubernetes",
                          context="the-cluster", domain="rc.example.org")
    try:
        lcmod._create_kubernetes(req, emit=spy)
    except Exception:  # noqa: BLE001
        pass
    assert not [m for lvl, m in seen if lvl == "warn" and "--domain" in m]

    # And a local cluster is never warned about — it costs nothing to leave running.
    for local in ("kind", "k3s"):
        plan(local)
        seen.clear()
        req = lcmod.CreateReq(version="8.5.1", runtime="kubernetes",
                              context="the-cluster")
        try:
            lcmod._create_kubernetes(req, emit=spy)
        except Exception:  # noqa: BLE001
            pass
        assert not [m for lvl, m in seen if lvl == "warn" and "--domain" in m], \
            f"{local} is free to leave running; there is nothing to warn about"


def test_the_idp_host_is_derived_on_kubernetes_too(tmp_path, monkeypatch):
    """It was derived below the runtime dispatch, so it was derived on Compose and
    not at all on Kubernetes.

    That is the defect the derivation exists to fix, surviving inside the runtime
    nobody was testing -- exactly the shape of the `doctor`/`plan_cluster` split that
    named one cluster while `up` built another. Both runtimes resolve the preset from
    `req.params`, so one call site above the fork covers both by construction, and
    this test is on the call site rather than on either branch.
    """
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: dict = {}

    def _fake_k8s(req, emit=None, **kw):
        seen["params"] = dict(req.params or {})
        return {"ok": True}

    monkeypatch.setattr(lc.create_k8s, "_create_kubernetes", _fake_k8s)
    req = lc.CreateReq(version="8.5.1", name="k", preset="oidc", runtime="kubernetes",
                       bind="0.0.0.0", root_url="http://box.example.com:3007")
    lc._create_repro_locked(req)
    assert seen["params"].get("idp_host") == "box.example.com", seen

    # `--domain` is the other way a caller says it, but this runtime refuses that
    # flag outright (it needs the Ingress `--https` needs), so `--root-url` is the
    # only route in here. Asserted for saml as well as oidc: they take the same param
    # and it would be easy to wire one.
    seen.clear()
    lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="k2", preset="saml",
                                         runtime="kubernetes", bind="0.0.0.0",
                                         root_url="http://box.example.com:3007"))
    assert seen["params"].get("idp_host") == "box.example.com", seen

    # Nothing invented for a plain Kubernetes workspace.
    seen.clear()
    lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="k3", preset="oidc",
                                         runtime="kubernetes"))
    assert not seen["params"].get("idp_host"), seen


def test_a_workspace_is_never_published_publicly_for_a_challenge(monkeypatch):
    """TLS-ALPN used to force --domain onto 0.0.0.0 so Let's Encrypt could connect.
    Nothing connects to the workspace now -- the edge answers the challenge -- so
    widening the bind on a repro running fixed weak credentials buys nothing."""
    from houston.services import lifecycle as lc

    req = lc.CreateReq(version="8.5.1", domain="t1.support.xyz.com",
                       acme_email="ops@xyz.com")
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    lc._resolve_tls(req, "w", "127.0.0.1")
    assert req.bind_public is False


def test_resolving_tls_refuses_a_hostname_another_workspace_holds(tmp_path, monkeypatch):
    """Refused where BOTH runtimes pass, so neither can grow its own answer."""
    from houston import errors
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.register("first", "taken.example.com")

    req = lc.CreateReq(version="8.5.1", name="second",
                       domain="taken.example.com", acme_email="o@e.com")
    with pytest.raises(errors.ConflictError) as exc:
        lc._resolve_tls(req, "second", "127.0.0.1", exclude="second")
    assert "already served for workspace 'first'" in str(exc.value)
    assert "houston down --name first" in str(exc.value), "say how to free it"

    # And the workspace that owns it can still be brought back up.
    again = lc.CreateReq(version="8.5.1", name="first",
                         domain="taken.example.com", acme_email="o@e.com")
    spec = lc._resolve_tls(again, "first", "127.0.0.1", exclude="first")
    assert spec.host == "taken.example.com"
