"""`houston.services.lifecycle.create_k8s`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import call_order
from conftest import source_index
from conftest import source_of
from houston.services import lifecycle as lc


def test_the_route_exists_before_the_chart_can_start_an_acme_order(monkeypatch):
    """Ordering, and it is the whole difference between a certificate and a timeout.

    cert-manager starts an ACME order the moment it sees the Ingress -- which the CHART
    creates during `helm install` -- and the http-01 challenge arrives on this host's
    :80. The first version of this published the name AFTER the install and after
    `wait_for_certificate`, so Let's Encrypt got a connection refused, the order
    failed, and the wait spent its whole budget on a challenge that could never have
    been answered.

    Asserted on the ORDER of the two calls, because that is the thing that was wrong.
    """

    route, install, prove = call_order(
        lc.create_k8s._create_kubernetes, "_route_kubernetes_name", "create_workspace",
        "_publish_kubernetes_name", through=lc.create_k8s)
    assert route < install, "the challenge must have somewhere to land before the chart"
    assert install < prove, "and the proof means nothing until the Ingress exists"


def test_a_refused_create_is_refused_before_the_write_ahead_record():
    """A refusal that created nothing must leave nothing behind.

    The provisional `repro.json` exists so a create that dies HALF WAY can still be
    found and removed -- a different situation from one that never started. With the
    ownership check only inside `ensure_namespace`, a refused create left an
    `incomplete` record that `prune` then offered to delete. Seen on a live cluster.

    Asserted on the order in the source, the same way the Kubernetes refusals are.
    """

    from houston.services import lifecycle as lc

    # Through the STEPS: the create is a plan and twelve of them now, and this is a
    # claim about the order they run in, not about one function's text.
    guard, record = call_order(lc.create_k8s._create_kubernetes,
                               "assert_namespace_available", "write_record",
                               through=lc.create_k8s)
    assert guard < record, "the ownership refusal must precede the write-ahead record"


def test_monitor_at_create_time_waits_for_the_workspace_first():
    """Attaching turns on RC's own Prometheus_Enabled over REST, so it needs a
    workspace that answers. `up --monitor` without `--wait` would otherwise attach
    to something not yet serving and fail -- which is exactly what `--seed` did
    before it was fixed on this path."""

    src = source_of(lc.create_k8s)
    monitor_at = source_index(src, "req.monitor")
    assert "wait_serving" in src[monitor_at:monitor_at + 400], \
        "--monitor must wait for the workspace before attaching"
