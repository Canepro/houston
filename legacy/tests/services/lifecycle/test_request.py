"""`houston.services.lifecycle.request`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston import presets


def test_naming_a_context_says_kubernetes_without_saying_it_twice(monkeypatch,
                                                                 tmp_path):
    """A context is a Kubernetes word.

    Measured on a first run: `--context <an eks arn>` without `--runtime kubernetes`
    was refused, and the whole command had to be retyped for the half houston could
    have worked out. Somebody who named a cluster has already said where it runs.

    Only from an EXPLICIT context, never from the box default — letting a default
    cluster silently move `up` off Compose would change what an un-flagged command
    means for every workspace on the box.
    """
    from houston import config
    from houston.services import lifecycle as lc
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    assert lc.infer_runtime(lc.CreateReq(version="8.5.1", context="arn:aws:eks:x")) \
        == topology.KUBERNETES
    # An explicit runtime always wins; inference never overrides what was typed.
    assert lc.infer_runtime(lc.CreateReq(version="8.5.1", context="arn:aws:eks:x",
                                         runtime="docker")) == "docker"
    assert lc.infer_runtime(lc.CreateReq(version="8.5.1")) == ""

    # THE BOX DEFAULT MUST NOT INFER. A configured cluster is a convenience for the
    # Kubernetes work somebody already does, not a statement that everything is now
    # Kubernetes.
    config.update_config(
        lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, "arn:aws:eks:default"))
    assert lc.infer_runtime(lc.CreateReq(version="8.5.1")) == "", \
        "a default cluster must not move an un-flagged `up` off Compose"


def test_unknown_set_param_rejected():
    # `--set agent=5` (typo for `agents`) was silently ignored before.
    from houston.services import lifecycle as lc
    p = presets.load("livechat")
    assert lc._unknown_params({"agent": "5"}, p) == ["agent"]      # typo caught
    assert lc._unknown_params({"agents": "5"}, p) == []            # correct key accepted
    assert lc._unknown_params({"x": "1"}, presets.load("default")) == ["x"]  # no-param preset
