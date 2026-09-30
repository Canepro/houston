"""`houston.services.lifecycle.preconditions`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
import pytest


def test_project_collision_guard(monkeypatch, tmp_path):
    # our workspace's compose path (what a same-home recreate would show)
    ours = str(tmp_path / "houston" / "repros" / "rc8-5-1" / "docker-compose.yml")
    monkeypatch.setattr(lc.runner.record, "project_name", lambda n: "houston-" + n)
    monkeypatch.setattr(lc.runner.paths, "workspace",
                        lambda n: tmp_path / "houston" / "repros" / n)

    # foreign project with our derived name -> refuse
    monkeypatch.setattr(lc.runner.queries, "project_config_files",
                        lambda: {"houston-rc8-5-1": "/Users/real/.houston/repros/rc8-5-1/docker-compose.yml"})
    with pytest.raises(errors.ConflictError):
        lc._guard_project_collision("rc8-5-1")

    # same project owned by OUR workspace (a --force recreate) -> allowed
    monkeypatch.setattr(lc.runner.queries, "project_config_files",
                        lambda: {"houston-rc8-5-1": ours})
    lc._guard_project_collision("rc8-5-1")   # no raise

    # docker unavailable / no such project -> skip (best-effort)
    monkeypatch.setattr(lc.runner.queries, "project_config_files", lambda: None)
    lc._guard_project_collision("rc8-5-1")
    monkeypatch.setattr(lc.runner.queries, "project_config_files", lambda: {})
    lc._guard_project_collision("rc8-5-1")


def test_reachable_beyond_loopback_is_the_whole_decision():
    """Both mechanisms, and the one that looks public and is not.

    A local-CA `--https` name resolves to 127.0.0.1. Treating it as exposed would
    rotate the password for the ordinary local case -- the common one -- for nothing.
    """
    from houston import config, tls as tlsmod  # noqa: F401
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    local = tlsmod.TlsSpec(mode=tlsmod.MODE_LOCAL, host="x.houston.localhost", port=443)
    assert lc.reachable_beyond_loopback(tlsspec=acme, bind_host="127.0.0.1")
    assert lc.reachable_beyond_loopback(tlsspec=None, bind_host="0.0.0.0")
    assert lc.reachable_beyond_loopback(tlsspec=None, bind_host="192.168.1.5")
    assert not lc.reachable_beyond_loopback(tlsspec=local, bind_host="127.0.0.1")
    assert not lc.reachable_beyond_loopback(tlsspec=None, bind_host="127.0.0.1")
    assert not lc.reachable_beyond_loopback(tlsspec=None, bind_host="::1")
    assert not lc.reachable_beyond_loopback(tlsspec=None, bind_host="")


def test_the_create_path_stamps_the_runtime_on_a_compose_workspace(monkeypatch, tmp_path):
    """The stamp has to happen on the REAL create path, not just be available as a
    helper. Compose workspaces are stamped too, deliberately: if only Kubernetes
    ones were, 'absent' would mean two different things -- an old workspace and a
    new compose one -- and no later reader could tell them apart.

    Captured at the `runner.write` seam, which is the last thing to see the
    metadata before it becomes repro.json.
    """
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    written: list = []
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc.runner.host, "docker_kernel_version", lambda: "6.1.0")
    monkeypatch.setattr(lc.runner.paths, "exists", lambda n: False)
    monkeypatch.setattr(lc.runner.ports, "used_ports", lambda **k: set())
    monkeypatch.setattr(lc.runner.ports, "port_free", lambda *a, **k: True)
    monkeypatch.setattr(lc.runner.record, "write",
                        lambda name, yaml, meta, files=None: written.append(meta))
    monkeypatch.setattr(lc.runner.engine, "up", lambda *a, **k: 0)
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: type("R", (), {
                            "rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                            "mongo_flavor": "mongodb", "mongo_shell": "mongosh",
                            "oplog": False, "source": "test", "note": ""})())
    try:
        lc._create_repro_locked(lc.CreateReq(version="8.6.1", name="stamped"))
    except Exception:                       # noqa: BLE001
        pass                                # whatever happens AFTER the write is not this test
    assert written, "the create path never reached runner.write"
    assert written[0].extra.get("runtime") == topology.DOCKER, (
        "a workspace was written with no runtime recorded — every later reader "
        "would have to guess, which is the ambiguity this key exists to remove")


def _a_kubernetes_request_carrying_compose_only_options(monkeypatch, tmp_path):
    """A create that asks for things only Docker Compose can do, on the runtime that cannot."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def req(**kw):
        return lc.CreateReq(version="8.5.1", runtime=topology.KUBERNETES, **kw)

    cases = [
        # `--reg-token` used to be here, refused because "the EE registration token
        # is injected through the preset environment, which this runtime does not
        # apply yet". Preset env had been applied here for some time, so the reason
        # had outlived itself while the flag stayed refused; it now travels in an
        # Opaque Secret referenced by `valueFrom`, and is asserted below.
        (req(fresh=True), "--fresh"),
    ]
    return cases, req


def _every_preset_is_honest_about_what_kubernetes_can_run(monkeypatch, req):
    """The presets that claim Kubernetes, and the refusal when one of them cannot deliver it."""
    # The refusal names the ones that DO work, so the answer is actionable.
    # EVERY preset reaches Kubernetes now, each with its own backing workload:
    # openldap, keycloak (twice), mailpit, minio, nginx. The guard stays because it
    # is what keeps a future preset from being recorded and never applied.
    from houston import presets
    for p in presets.list_presets():
        # `multi-instance` is a DEPLOYMENT on this branch, not a scenario -- the
        # legacy YAML still exists in the catalogue and correctly refuses here,
        # because its nats/traefik pair is what --deployment provides natively.
        if p.name == "multi-instance":
            with pytest.raises(errors.ValidationError):
                lc._refuse_unsupported_on_kubernetes(req(preset=p.name))
            continue
        lc._refuse_unsupported_on_kubernetes(req(preset=p.name))

    # And it still bites: a preset with backing services and no manifests is refused,
    # naming the services that would have been missing.
    import dataclasses
    broken = dataclasses.replace(presets.load("email"), kubernetes_manifests=[])
    monkeypatch.setattr(presets, "resolve", lambda *a, **kw: broken)
    with pytest.raises(errors.ValidationError) as caught:
        lc._refuse_unsupported_on_kubernetes(req(preset="email"))
    assert "mailpit" in str(caught.value), caught.value


def test_kubernetes_refuses_what_it_would_silently_drop(monkeypatch, tmp_path):
    """Five create options were ACCEPTED and then ignored on this runtime.

    `--preset ldap` is the clearest: the Kubernetes path's only `presets.load` is a
    hardcoded "default", so the name was written into repro.json and nothing else
    happened -- `houston list` showed "ldap" for a workspace with no LDAP in it. A
    create that reports success and produces something else is the worst outcome
    available, and it is the failure mode this whole runtime split keeps producing:
    --seed, --https, mongo_flavor and mongo_shell were all the same shape.

    `--fresh` is the one that matters most and is reported first: it means DELETE
    this workspace's data, and the Kubernetes path keeps the PersistentVolumeClaim.
    """
    cases, req = _a_kubernetes_request_carrying_compose_only_options(monkeypatch, tmp_path)
    for creq, expected in cases:
        with pytest.raises(errors.ValidationError) as caught:
            lc._refuse_unsupported_on_kubernetes(creq)
        assert expected in str(caught.value), f"{expected}: {caught.value}"

    # `--https` HAS LEFT THIS TABLE, and that is the point of the change rather than a
    # gap in it. A runtime-wide "not supported" cannot say which of four different
    # things is missing, so it was replaced by refusals about THIS CLUSTER, in
    # `_kubernetes_tls_plan`: no ingress class, no cert-manager, no reachable :443
    # Service, or a cluster that is not on this machine. The table's job is to catch
    # what would be ACCEPTED AND DROPPED, and --https is now honoured.
    lc._refuse_unsupported_on_kubernetes(req(https="local"))

    # `--domain` HAS ALSO LEFT, and for the same reason: what was missing was an ACME
    # ClusterIssuer, and that is now one IssuerSpec away from the `ca` one. The table
    # is down to the one option that is genuinely dropped rather than refused.
    lc._refuse_unsupported_on_kubernetes(req(domain="x.example",
                                             acme_email="ops@example.com"))
    assert [f["field"] for f in lc.unsupported_fields("kubernetes")] == ["fresh"]

    # What IS supported must still pass straight through, or this becomes a wall.
    lc._refuse_unsupported_on_kubernetes(req(preset="default", name="x", pin=True,
                                             monitor=True, seed=True, wait=True,
                                             mongo_operator=True, replicas=3,
                                             reg_token="abc"))
    # And `ldap` passes now BECAUSE it has an adapter -- the refusal is per preset,
    # not a blanket "presets do not work here". That is what slice 4 bought.
    lc._refuse_unsupported_on_kubernetes(req(preset="ldap", params={"users": "3"}))
    _every_preset_is_honest_about_what_kubernetes_can_run(monkeypatch, req)


def test_the_agent_skill_does_not_claim_a_refusal_the_code_stopped_making():
    """A fifth registry walk, and this one guards a document rather than a table.

    `data/skill/SKILL.md` instructs something that is not a person, and its whole
    reason for existing is that a caller told the wrong thing has no way to notice. It
    said `--https` / `--domain` "does not create an Ingress for a Kubernetes workspace
    yet ... use `--runtime docker` when the case needs TLS" — long after the Kubernetes
    path grew an Ingress, a cert-manager issuer and a Let's Encrypt certificate proven
    against a live EKS cluster. Nothing caught it, because nothing compared the
    document to the registry it was describing.

    `_KUBERNETES_UNSUPPORTED` is that registry, and it is the same one `/api/settings`
    serves to the create dialog so a field can be ABSENT rather than refused. Anything
    that has left it is supported, and the skill must not go on refusing it.
    """
    import pathlib

    from houston.services import lifecycle as lcmod

    # From the PACKAGE root, not by counting `.parent` hops off a service module: the
    # hop count changed the moment `lifecycle.py` became `lifecycle/`, and a path built
    # by counting is a path that breaks on every split.
    import houston
    text = (pathlib.Path(next(iter(houston.__path__)))
            / "data" / "skill" / "SKILL.md").read_text()
    refused = {f["field"] for f in lcmod.unsupported_fields("kubernetes")}
    assert refused, "the registry itself is empty — this walk would prove nothing"

    # The section that enumerates refusals, so a passing MENTION of a flag elsewhere
    # ("`--domain` creates an Ingress") is not read as a claim that it is refused.
    start = text.index("### What Kubernetes refuses, and why")
    end = text.index("###", start + 10)
    block = text[start:end]

    for field in ("https", "domain", "fresh", "reg_token"):
        flag = "--" + field.replace("_", "-")
        claimed = f"- `{flag}`" in block or f"`{flag}` /" in block
        if field in refused:
            assert claimed, (
                f"{flag} IS refused on Kubernetes and the skill does not say so — an "
                f"agent will hand a user a command that fails.")
        else:
            assert not claimed, (
                f"the skill still refuses {flag} on Kubernetes, and the code does not. "
                f"An agent reading this sends users to `--runtime docker` for something "
                f"that works — which is exactly how this drifted the first time.")
