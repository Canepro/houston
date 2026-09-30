"""`houston.services.lifecycle.sizing`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _mem
import pytest


def test_the_reserve_scales_with_the_host():
    from houston.services import lifecycle as lc

    assert lc.host_reserve_mb(10024) == 2004, "a fifth of a 10 GB box"
    assert lc.host_reserve_mb(2048) == 1024, "never below 1 GB on a small one"


def test_the_control_plane_is_charged_only_when_one_is_about_to_be_built(monkeypatch, tmp_path):
    """It is shared, so billing it to the second and third workspace would refuse creates
    the host could hold -- and a capacity check that is wrong in the safe direction still
    stops people using the tool, which is how they learn to pass --force by reflex.

    The charge now turns on whether this create will BUILD a control plane, which is the
    only case where its memory is new.
    """
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    req = lc.CreateReq(version="8.6.1", runtime="k8s", deployment=topology.MONOLITH)

    assert lc._kube_overhead_mb(req, provisioning=True) == lc.CLUSTER_MB + lc.KUBE_CHART_MB, \
        "the create that builds the cluster pays for it"
    assert lc._kube_overhead_mb(req, provisioning=False) == lc.KUBE_CHART_MB, \
        "the rest share the cluster but still pay for their own chart"


def test_the_microservices_surcharge_matches_the_pods_that_were_observed():
    """Half measured, half estimated, and the test says which.

    MEASURED live on chart 7.0.2: nine pods against a monolith's five, the four
    extra being account, authorization, ddp-streamer and presence. NOT five -- this
    chart ships no stream-hub deployment, which the first estimate assumed.

    STILL ESTIMATED: what they cost. Both memory readings were taken at readiness
    with pods still ContainerCreating, and the microservices one came out LOWER than
    the monolith's, which cannot be true.
    """
    from houston.services import lifecycle as lc

    assert lc.MICROSERVICES_MB == 800, "4 observed pods x ~200 MB"
    # Generous on purpose: under-charging lets through a create that OOMs a swapless
    # host, and the kernel picks its own victim.
    assert lc.MICROSERVICES_MB >= 4 * 200
    # And it is charged ON TOP of the chart baseline, not instead of it -- NATS is
    # in KUBE_CHART_MB because a monolith runs it too.
    assert lc.KUBE_CHART_MB > 0 and lc.CLUSTER_MB > 0


def test_the_advertised_force_override_actually_overrides(monkeypatch):
    """The refusal tells the user to pass --force. It has to then work.

    The test above pins the WORDS "--force" in the message; nothing pinned the
    behaviour, and check_capacity never read req.force -- so the documented escape
    hatch did not exist. Following the instruction produced the identical refusal,
    and because `up --force` also means "overwrite this repro", obeying the advice
    risked destroying a workspace while still being blocked.

    Found by an audit that hit the refusal, did what it said, and was refused again.
    The override also has to stay LOUD: this is the guard added after an OOM killer
    took out a 10 GB host, so bypassing it is reported, not silent.
    """
    from houston.services import lifecycle as lc
    from houston.services.events import Event

    _mem(monkeypatch, available_mb=1000)          # 100 MB usable: nowhere near enough
    seen: list[Event] = []
    lc.check_capacity(lc.CreateReq(version="8.5.1", force=True), "",
                      seen.append)                # must NOT raise

    warnings = [e for e in seen if e.level == "warn"]
    assert warnings, "an OOM guard must not be bypassed silently"
    text = " ".join(e.message for e in warnings)
    assert "--force" in text, "say which flag did this"
    assert "OOM" in text, "and what the consequence is"

    # Without it, the same host state still refuses -- this widens nothing else.
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1"))


def test_plenty_of_memory_is_not_refused(monkeypatch):
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=9000)
    lc.check_capacity(lc.CreateReq(version="8.5.1"))       # must not raise


def test_a_preset_with_keycloak_needs_more_than_a_bare_workspace(monkeypatch):
    """saml/oidc run Keycloak, which is the biggest sidecar there is."""
    from houston import errors
    from houston.services import lifecycle as lc

    # Enough for a bare workspace, not for one plus Keycloak.
    _mem(monkeypatch, available_mb=lc.host_reserve_mb(10024) + lc.WORKSPACE_MB + 100)
    lc.check_capacity(lc.CreateReq(version="8.5.1"))       # bare: fits
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1"), "saml")


def test_monitoring_counts_towards_the_estimate(monkeypatch):
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=lc.host_reserve_mb(10024) + lc.WORKSPACE_MB + 100)
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1", monitor=True))


def test_the_last_workspace_warns_before_the_ceiling(monkeypatch):
    """The ceiling should be visible BEFORE it is hit, not only in the refusal."""
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=lc.host_reserve_mb(10024) + lc.WORKSPACE_MB + 200)
    seen: list = []
    lc.check_capacity(lc.CreateReq(version="8.5.1"), "", lambda ev: seen.append(ev))
    assert any("is left" in str(getattr(e, "message", e)) for e in seen)


# --- capacity knows what Kubernetes costs ---------------------------------------

def test_a_kubernetes_workspace_is_not_charged_as_a_compose_one(monkeypatch, tmp_path):
    """`check_capacity` computed `WORKSPACE_MB + PRESET_MB` and nothing about the
    runtime, so a Kubernetes workspace was billed as if it were Compose -- missing a
    control plane (573 MiB measured) and five extra Node processes.

    This function exists because seven concurrent stacks OOM-killed a 10 GB host.
    Under-charging is not a rounding error here: the OOM killer picks its own
    victim, so it destroys somebody else's work.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda _t: "")     # no cluster of ours

    compose = lc.CreateReq(version="8.6.1")
    assert lc._kube_overhead_mb(compose) == 0, "Compose must be unaffected"

    # Kubernetes with nothing resolved: an empty deployment means that runtime's
    # DEFAULT, which is microservices -- the expensive one. Reading empty as free
    # would under-charge the common case.
    default_k8s = lc.CreateReq(version="8.6.1", runtime="kubernetes")
    assert lc._kube_overhead_mb(default_k8s) == (lc.CLUSTER_MB + lc.KUBE_CHART_MB
                                                + lc.MICROSERVICES_MB)

    mono = lc.CreateReq(version="8.6.1", runtime="k8s",
                        deployment=topology.MONOLITH)
    # A "monolith" on this chart is five pods, not two -- it runs NATS regardless
    # of microservices.enabled -- so it pays for the cluster AND the chart baseline.
    assert lc._kube_overhead_mb(mono) == lc.CLUSTER_MB + lc.KUBE_CHART_MB


def test_a_cluster_that_is_already_running_is_not_charged_for(monkeypatch, tmp_path):
    """INVERTED, deliberately, and the old reasoning is worth recording.

    This charge used to be keyed on whether houston's OWN kind cluster existed, on the
    argument that "somebody else's cluster being up does not mean the control plane is
    already paid for" -- true while houston always created its own alongside, and wrong
    the moment it can use one that is already running, where the 600 MB is spent whatever
    this create does. Charging it anyway refuses creates the box can hold, on a box whose
    only cluster is the one about to be adopted.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    req = lc.CreateReq(version="8.6.1", runtime="kubernetes", deployment=topology.MONOLITH)
    # A k3s cluster that is up: nothing to build, so nothing to charge.
    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context="default", distribution="k3s", create=False))
    assert lc._will_provision(req) is False
    assert lc._kube_overhead_mb(req, lc._will_provision(req)) == lc.KUBE_CHART_MB

    # And with kind and no cluster yet, the control plane is real and is charged.
    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    assert lc._will_provision(req) is True
    assert lc._kube_overhead_mb(req, lc._will_provision(req)) == \
        lc.CLUSTER_MB + lc.KUBE_CHART_MB


def test_no_cluster_and_no_kind_charges_nothing_because_the_create_refuses(monkeypatch, tmp_path):
    """The old rule was "an unprobeable cluster is charged for", on the reasoning that
    assuming it exists would let the create through and spend the memory anyway.

    There is nothing to be safe about any more: the only thing `plan_cluster` raises for
    is having no cluster AND no way to make one, and that create is refused before a byte
    is written. Charging for a control plane that will never be built would refuse for
    memory a create was never going to spend.
    """
    from houston.services import k8s, topology
    from houston.errors import PreflightError

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    def refuse(*_a, **_k):
        raise PreflightError("kind is not installed, ...")
    monkeypatch.setattr(k8s.context, "plan_cluster", refuse)
    # MONOLITH explicitly: an empty deployment means "that runtime's default", which for
    # Kubernetes is microservices and carries its own 800 MB.
    req = lc.CreateReq(version="8.6.1", runtime="k8s", deployment=topology.MONOLITH)
    assert lc._will_provision(req) is False
    assert lc._kube_overhead_mb(req, lc._will_provision(req)) == lc.KUBE_CHART_MB


def test_the_kubernetes_overhead_actually_reaches_the_refusal(monkeypatch, tmp_path):
    """The helper existing is not the same as it being used. Asserted end-to-end
    through `check_capacity`, because a correct estimate nothing consults refuses
    nothing -- and the first version of this change computed the overhead and then
    did not add it to `need`.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # A kind box with no cluster yet, so the control plane is part of the bill. STATED
    # rather than probed: `check_capacity` now asks which cluster it would use, and a
    # unit test must not depend on whether one happens to be running on the machine.
    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    # A host with room for exactly one Compose workspace and no more.
    need_k8s = (lc.WORKSPACE_MB + lc.CLUSTER_MB + lc.KUBE_CHART_MB
                + lc.MICROSERVICES_MB)
    tight = lc.WORKSPACE_MB + 200
    monkeypatch.setattr(lc.runner.host, "host_memory",
                        lambda: (8000, tight + lc.host_reserve_mb(8000), 0))
    monkeypatch.setattr(lc.runner.record, "list_meta", lambda: [])

    # Compose fits.
    lc.check_capacity(lc.CreateReq(version="8.6.1"), "default")
    # The same host cannot hold a Kubernetes one, and must say so.
    with pytest.raises(errors.PreflightError) as caught:
        lc.check_capacity(lc.CreateReq(version="8.6.1", runtime="kubernetes"),
                          "default")
    assert need_k8s > tight, "the fixture must actually be too small"
    assert f"{need_k8s} MB" in str(caught.value), "the bill must include the Kubernetes parts"
    # And it is a PREFLIGHT failure, not a "poll again". errors.py already said so
    # -- "capacity shortfalls ... use this" -- while the code raised NotReadyError,
    # exit 5, which tells a script to retry something retrying cannot fix. Polling
    # does not free memory. Same argument that moved `require_docker` off exit 5.
    assert caught.value.exit_code == 3, "a full host is a preflight failure"
    assert caught.value.code == "PREFLIGHT_FAILED"


def test_force_does_not_switch_the_memory_preflight_off(monkeypatch, tmp_path):
    """`check_capacity` has a `--force` branch that WARNS and proceeds, added because
    "this is the guard that exists after an OOM took out a 10 GB host: overriding it
    has to stay visible".

    The caller excluded force from the call entirely, so for a new workspace the
    function was never reached and the loud override was a silent one.
    """
    from houston.services import lifecycle as lcsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    calls: list = []
    monkeypatch.setattr(lcsvc.sizing, "check_capacity",
                        lambda *a, **k: calls.append(True))
    monkeypatch.setattr(lcsvc.runner.engine, "up", lambda *a, **k: 0)
    monkeypatch.setattr(lcsvc.runner.engine, "down", lambda *a, **k: 0)

    for force in (False, True):
        calls.clear()
        try:
            lcsvc.create_repro(lcsvc.CreateReq(version="8.5.1", name=f"cap{int(force)}",
                                               force=force))
        except Exception:               # noqa: BLE001 - the boot is not the subject
            pass
        assert calls, f"check_capacity was never called with force={force}"


def test_an_unreadable_engine_is_not_evidence_of_a_small_one(monkeypatch):
    """A refusal on no evidence is how people learn to pass --force by reflex."""
    monkeypatch.setattr(lc.runner.host, "docker_capacity", lambda: None)
    monkeypatch.setattr(lc.runner.host, "host_memory", lambda: (16000, 12000, 0))
    lc.check_capacity(lc.CreateReq(version="8.5.1", runtime="kubernetes"))
