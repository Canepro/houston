"""`houston.services.k8s.chart`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
import pytest
import subprocess


def test_the_oplog_url_is_only_emitted_for_the_versions_that_use_it():
    """RC 8.x dropped oplog tailing, so emitting it there is wrong in the other
    direction. The rule lives in versions.py and applies to both runtimes; this
    checks the Kubernetes chart values honour it."""
    from houston.services import k8s

    with_oplog = k8s.values_for(rc_version="7.10.0", rc_image="i", microservices=False,
                                oplog=True, mongo_url="m", oplog_url="o")
    without = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                             oplog=False, mongo_url="m")
    assert with_oplog["externalMongodbOplogUrl"] == "o"
    assert "externalMongodbOplogUrl" not in without


def test_a_kubernetes_workspace_advertises_the_url_it_is_reached_on():
    """This runtime set no ROOT_URL at all, on any workspace it ever made.

    The chart emits one only from `.Values.host`, and nothing passed it -- so
    Rocket.Chat ran on its own built-in default while every human reached it on an
    allocated port. ROOT_URL is what absolute links, OAuth callbacks and CORS derive
    from, so it was wrong for all three. Compose has always set it.

    And never twice: with `host` given, the chart writes ROOT_URL itself, and a
    second entry from `extraEnv` is a server-side-apply failure rather than an
    override -- the same `duplicate entries for key` that DEPLOY_PLATFORM produced.
    """
    from houston.services import k8s

    plain = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                           root_url="http://localhost:32812")
    env = {e["name"]: e.get("value") for e in plain["extraEnv"]}
    assert env.get("ROOT_URL") == "http://localhost:32812", env
    assert "host" not in plain, "a port-forward workspace has no ingress host"

    # With a name, the chart derives the URL -- so extraEnv must NOT carry one.
    named = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                           host="ticket.houston.localhost")
    assert [e for e in named["extraEnv"] if e["name"] == "ROOT_URL"] == [], \
        "the chart already emits ROOT_URL from `host`; a second entry is a conflict"

    # Asking for both is the caller not knowing which mechanism it wants.
    with pytest.raises(errors.ValidationError):
        k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                       root_url="http://localhost:1", host="a.example.com")


def test_a_monolith_does_not_run_a_nats_cluster_it_never_uses():
    """K-15. The chart defaults `nats.enabled` on independently of
    `microservices.enabled`, so `--deployment monolith` ran a 3-pod NATS cluster
    nothing connected to -- three more pods to schedule, wait for and tear down.
    Confirmed by rendering chart 7.0.2: 6 NATS objects without this, 0 with it.
    """
    from houston.services import k8s

    mono = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                          host="rc.example.com")
    micro = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=True,
                           host="rc.example.com")
    assert mono["nats"]["enabled"] is False
    assert micro["nats"]["enabled"] is True
    # The cluster NAME stays either way: it is what the chart's own values call it.
    assert mono["nats"]["cluster"]["name"] == micro["nats"]["cluster"]["name"]


def _a_repo_of_charts_from_several_eras(monkeypatch):
    """A helm repo answering with chart versions spanning years."""
    import json as _json

    from houston import errors
    from houston.services import k8s

    # The real shape of the index at its old end, from the live repository.
    index = [{"version": "0.1.0", "app_version": "1.16.0"},
             {"version": "3.0.0", "app_version": "3.7.2"},
             {"version": "6.4.4", "app_version": "6.4.4"},
             {"version": "7.0.2", "app_version": "8.6.1"}]
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: subprocess.CompletedProcess(
        [], 0, _json.dumps(index), ""))
    return errors, k8s


def test_a_chart_from_another_era_is_refused_rather_than_installed(monkeypatch):
    """The floor rule is right; below the chart repo's own history it runs out.

    MEASURED against the live index: 96 chart versions, and below 3.0.0 there is
    exactly one — 0.1.0, appVersion 1.16.0 — with nothing in between. So every request
    below chart 3.0.0's appVersion landed on a 1.16-era chart that predates `extraEnv`,
    `microservices.*`, `mongodb.enabled` and the security-context handling: every
    values key houston sets. It would render something, and not a working workspace.

    Refusing beats that and beats a pod that never starts, because the tool HAS an
    answer for these versions — the Docker runtime supports them natively.
    """
    errors, k8s = _a_repo_of_charts_from_several_eras(monkeypatch)

    assert k8s.resolve_chart_version("6.4.4") == "6.4.4", "exact match still wins"
    assert k8s.resolve_chart_version("5.0.0") == "3.0.0", \
        "the floor rule is correct wherever a same-era chart exists"

    for old in ("3.0.0", "2.4.14", "1.0.0"):
        try:
            got = k8s.resolve_chart_version(old)
        except errors.ValidationError as exc:
            assert "Docker runtime" in str(exc), \
                "a refusal that does not name the answer is half a refusal"
            assert "0.1.0" in str(exc) and "1.16.0" in str(exc), \
                "and it has to show WHY — the chart it would otherwise have used"
        else:
            raise AssertionError(f"RC {old} resolved to chart {got}, a different era")

    # THE BOUNDARY ITSELF RESOLVES. Refusing one version too many would take away
    # Kubernetes support for a version that works.
    assert k8s.resolve_chart_version("3.7.2") == "3.0.0"

    # AND A VERSION NEWER THAN EVERY CHART IS THE OPPOSITE CASE, kept as it was: the
    # chart repo has not caught up with a fresh RC release, and the newest chart is the
    # honest best effort. Answering an OLD version that way was the bug -- RC 1.0.0
    # resolved to chart 7.0.2, which deploys 8.6.1, the furthest possible thing from
    # what was asked.
    # A VERSION NEWER THAN EVERY CHART IS THE OPPOSITE CASE and is not refused: the
    # chart repo has not caught up with a fresh RC release, and the newest chart at or
    # below it is the honest best effort. Answering an OLD version that way was the
    # bug — RC 1.0.0 resolved to chart 7.0.2, which deploys 8.6.1.
    said: list = []
    assert k8s.resolve_chart_version("99.0.0",
                                     emit=lambda e: said.append(e.message)) == "7.0.2"

    # AND IT SAYS NOTHING ON THE WAY. A chart behind the app is the normal case --
    # "most Rocket.Chat releases have no chart with a matching appVersion" -- so a line
    # about it fired on essentially every create, immediately before `chart X for
    # Rocket.Chat Y` said the same thing better. Observed on a real create as noise.
    assert said == [], said
    said.clear()
    k8s.resolve_chart_version("6.4.4", emit=lambda e: said.append(e.message))
    assert said == [], said


def test_a_scenarios_settings_reach_the_rocket_chat_container(monkeypatch):
    """The SHARED half of the Scenario contract, and the half that silently did not
    arrive.

    `values_for` took `preset_env`, threaded it from `create_workspace`, and then
    never used it -- the parameter was declared, passed, and dropped on the floor.
    The live run showed the symptom exactly: OpenLDAP deployed, ready and labelled,
    and Rocket.Chat with no LDAP setting on it at all. A backing service nothing is
    configured to use is the same silent-drop shape as the rest of this runtime,
    one level further in.

    Appended AFTER the base list so a preset can override a default rather than be
    overridden by one -- the precedence compose.py already gives it.
    """
    from houston import presets
    from houston.services import k8s, topology

    preset = presets.resolve("ldap", topology.KUBERNETES, {"users": "7"})
    values = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                            preset_env=preset.env)
    got = {e["name"]: e["value"] for e in values["extraEnv"]}
    assert got.get("OVERWRITE_SETTING_LDAP_Host") == "openldap", got
    assert got.get("OVERWRITE_SETTING_LDAP_Enable") in ("true", "True"), got
    # The workspace's own admin env must survive alongside it.
    # The workspace's own admin env survives alongside it; INITIAL_USER is gone from
    # both runtimes and does not come back (see the extraEnv test above).
    assert got["ADMIN_USERNAME"] and "INITIAL_USER" not in got

    # A preset wins over a base default, rather than the other way round.
    override = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                              preset_env={"ADMIN_NAME": "Scenario"})
    names = [e["value"] for e in override["extraEnv"] if e["name"] == "ADMIN_NAME"]
    assert names[-1] == "Scenario", names


def test_the_chart_value_host_is_a_hostname_and_a_url_is_refused():
    """The chart CONCATENATES, so a URL here rendered a nonsense ROOT_URL.

    `rocketchat/rocketchat` 7.0.2, templates/chat-deployment.yaml:

        - name: ROOT_URL
          value: https://{{ .Values.host }}

    and `values_for` took a parameter called `root_url` and assigned it straight to
    `values["host"]`. Rendered with what `_create_kubernetes` computes:

        $ helm template rocketchat . --set host=http://localhost:32812
                - name: ROOT_URL
                  value: https://http://localhost:32812

    `.Values.host` is also the Ingress rule host, so the same value corrupts both
    the URL Rocket.Chat advertises and the name an ingress would route -- which is
    exactly what the HTTPS work has to set. Refused rather than normalised: a caller
    passing a URL here has a bug, and stripping the scheme would hide it.
    """
    from houston.services import k8s

    with pytest.raises(errors.ValidationError) as exc:
        k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                       host="http://localhost:32812")
    assert "bare hostname" in str(exc.value)
    # A port is the same trap one character smaller.
    with pytest.raises(errors.ValidationError):
        k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                       host="ticket.houston.localhost:443")
    # The legitimate shape, which is what the official values.yaml documents.
    values = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                            host="ticket.houston.localhost")
    assert values["host"] == "ticket.houston.localhost"
