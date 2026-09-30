"""`houston.services.k8s.ingress`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
import pytest


def test_the_ingress_values_are_the_official_guides_shape():
    """From docs.rocket.chat/docs/deploy-with-kubernetes, and the point is that a
    customer's values.yaml and houston's differ only in the issuer NAME:

        host: <domain.xyz>
        ingress:
          enabled: true
          ingressClassName: traefik
          annotations:
            cert-manager.io/cluster-issuer: production-cert-issuer
          tls:
            - secretName: rckube
              hosts: [<domain.xyz>]
    """
    from houston.services import k8s

    v = k8s.ingress_values("ws.houston.localhost", ingress_class="traefik",
                           secret_name="ws-tls")
    assert v["host"] == "ws.houston.localhost"
    assert v["ingress"]["enabled"] is True
    assert v["ingress"]["ingressClassName"] == "traefik"
    assert v["ingress"]["annotations"] == {
        "cert-manager.io/cluster-issuer": k8s.CA_ISSUER}
    assert v["ingress"]["tls"] == [{"secretName": "ws-tls",
                                    "hosts": ["ws.houston.localhost"]}]


def test_naming_an_ingress_class_is_obeyed_or_refused_never_quietly_ignored(monkeypatch):
    """Somebody who passes `--ingress-class alb` and silently gets nginx has been
    overruled without being told, which is worse than an error.

    And when several exist and none was named, the choice is stated: it is a decision,
    and this emit is the only place it is visible.
    """
    from houston import errors
    from houston.services import k8s

    monkeypatch.setattr(k8s.capabilities, "ingress_classes", lambda ctx: ["nginx", "alb"])
    said: list = []
    got = k8s.ensure_ingress(context="c", distribution="eks", prefer="alb",
                             emit=lambda e: said.append(e.message))
    assert got == "alb" and any("as asked" in m for m in said), said

    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_ingress(context="c", distribution="eks", prefer="traefik")
    assert "traefik" in str(exc.value) and "nginx, alb" in str(exc.value), \
        "the refusal has to say what the cluster actually has"

    said.clear()
    got = k8s.ensure_ingress(context="c", distribution="eks",
                             emit=lambda e: said.append(e.message))
    assert got == "nginx"
    assert any("this cluster has nginx, alb" in m and "--ingress-class" in m
               for m in said), said

    # ONE class is the ordinary case and must not gain a choice-of-several sentence.
    monkeypatch.setattr(k8s.capabilities, "ingress_classes", lambda ctx: ["traefik"])
    said.clear()
    assert k8s.ensure_ingress(context="c", distribution="eks",
                              emit=lambda e: said.append(e.message)) == "traefik"
    assert not any("--ingress-class" in m for m in said), said
