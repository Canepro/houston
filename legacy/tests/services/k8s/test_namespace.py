"""`houston.services.k8s.namespace`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from servicehelpers import _completed
import json
import pytest


def test_a_namespace_houston_did_not_make_is_refused_not_adopted(monkeypatch):
    """`ensure_namespace` ran `create` (ignoring the result, so an existing namespace
    was fine) and then `label --overwrite` whatever was there.

    That stamped houston's ownership onto a namespace it did not make, after which
    `down --volumes` deletes it and its PersistentVolumeClaims. The realistic trigger
    is not a stranger: it is two houston users on one adopted cluster, because name
    collisions are guarded through the local repro.json and another user's home is
    invisible from here. The namespace's own labels are the only evidence there is,
    and overwriting them destroyed it.
    """
    from houston.errors import ConflictError
    from houston.services import k8s

    def _labels_are(labels):
        monkeypatch.setattr(k8s.namespace, "namespace_labels", lambda ns, **kw: labels)

    labelled = {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                k8s.WORKSPACE_LABEL: "mine"}

    # Somebody else's namespace, or one an older houston left unlabelled: refused
    # either way, because houston cannot tell them apart and being wrong deletes data.
    _labels_are({})
    with pytest.raises(ConflictError) as caught:
        k8s.ensure_namespace("mine", context="c")
    assert "not managed by houston" in str(caught.value)
    assert "kubectl delete namespace" in str(caught.value), "name the manual step"

    # houston's, but another workspace's.
    _labels_are({**labelled, k8s.WORKSPACE_LABEL: "theirs"})
    with pytest.raises(ConflictError) as caught:
        k8s.ensure_namespace("mine", context="c")
    assert "'theirs'" in str(caught.value)

    # houston's, this workspace, another user.
    _labels_are({**labelled, k8s.OWNER_OF_LABEL: "bob"})
    with pytest.raises(ConflictError) as caught:
        k8s.ensure_namespace("mine", context="c", owner="alice")
    assert "bob" in str(caught.value)

    # Ours, this workspace: reused, and never re-created.
    _labels_are(labelled)
    calls = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: calls.append(argv) or _completed())
    assert k8s.ensure_namespace("mine", context="c") == k8s.namespace_for("mine")
    assert not any("create" in a for a in calls), calls
    assert any("label" in a for a in calls), calls


def test_cannot_ask_the_cluster_is_not_the_same_answer_as_nothing_is_there(monkeypatch):
    """`workspace_namespaces()` returned [] both when there was nothing there and when
    the cluster could not be asked, and `delete_namespace` read the second as the
    first.

    So a wrong kube-context, an expired credential or an RBAC denial reported
    "nothing to remove" -- and the caller then deleted the local record and said the
    namespace and its PersistentVolumeClaim were gone, while all of it went on running
    with the only record that knew about it destroyed.
    """
    from houston.errors import DockerError
    from houston.services import k8s

    # Genuinely absent.
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: _completed(
        1, err='Error from server (NotFound): namespaces "houston-x" not found'))
    assert k8s.namespace_labels("houston-x", context="c") is None

    # Could not ask -- and that must not look like absence.
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: _completed(
        1, err="Unable to connect to the server: dial tcp: i/o timeout"))
    with pytest.raises(DockerError) as caught:
        k8s.namespace_labels("houston-x", context="c")
    assert "refusing to guess" in str(caught.value)
    with pytest.raises(DockerError):
        k8s.delete_namespace("x", context="c", volumes=True)


def test_a_cluster_that_cannot_be_asked_never_reads_as_a_deleted_namespace(monkeypatch):
    """`delete_namespace`'s wait loop read `returncode != 0` as "the namespace is
    gone" -- so ONE transient API error, one expired credential or one wrong context
    made `down --volumes` announce a deletion that had not happened and drop the local
    record, leaving a namespace with no houston path back to it.

    Measured on this box: kubectl exits **1** for an absent namespace AND for a
    context that does not exist, so no threshold on the exit code can tell them
    apart. The exit code says only whether the API server answered; absence has to
    come from the payload. `.docs/design/k8s-answer-contract.md` has the runs.

    This is the `down` half. `wait_namespace_gone` below is the `prune` half, and it
    had the identical defect twenty lines away.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.namespace, "namespace_labels",
                        lambda ns, **kw: {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                                          k8s.WORKSPACE_LABEL: "x"})
    monkeypatch.setattr(k8s.namespace, "workspace_pvcs", lambda *a, **k: ["data-x-0"])

    def _run(argv, **kw):
        if "delete" in argv:
            return _completed(0)
        # The cluster cannot be asked. NOT `Error from server (NotFound)`, which is
        # the API server asserting absence -- this is a client-side failure, and the
        # two must not land in the same branch.
        return _completed(1, err="Unable to connect to the server: dial tcp: "
                                 "i/o timeout")

    monkeypatch.setattr(k8s.kube, "run", _run)
    said: list = []
    assert k8s.delete_namespace("x", context="c", volumes=True,
                                emit=lambda e: said.append(e.message),
                                sleep=lambda s: None) is False, \
        "a namespace nobody could ask about was reported deleted"
    joined = " ".join(said)
    assert "could not confirm" in joined, joined
    assert "record is KEPT" in joined, "say what was NOT done"
    # A DIFFERENT SENTENCE from the Terminating case, because the remedy differs:
    # one says wait, this one says go and look at your cluster.
    assert "still terminating" not in joined, \
        "an unreachable cluster is not a namespace that is taking its time"


def test_a_namespace_still_terminating_is_not_reported_as_gone(monkeypatch):
    """`delete_namespace` waited, then returned True even while the namespace was
    still Terminating -- and True is read as "confirmed absent", so the caller deleted
    the local record and tore down the shared operator and monitoring stack.

    Finalizers can wedge indefinitely; the workspace was then an orphan with no
    houston path left to it.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.namespace, "namespace_labels",
                        lambda ns, **kw: {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                                          k8s.WORKSPACE_LABEL: "x"})
    monkeypatch.setattr(k8s.namespace, "workspace_pvcs", lambda *a, **k: ["data-x-0"])

    def _run(argv, **kw):
        if "delete" in argv:
            return _completed(0)
        # The document a real `get namespace -o json` returns, not a bare phase
        # string: `-o json` is what the code asks for, so a stub answering with
        # anything else is testing a wire shape that does not exist.
        return _completed(0, out=json.dumps({                # never goes away
            "metadata": {"name": "houston-x"},
            "status": {"phase": "Terminating"}}))

    monkeypatch.setattr(k8s.kube, "run", _run)
    said: list = []
    assert k8s.delete_namespace("x", context="c", volumes=True,
                                emit=lambda e: said.append(e.message),
                                sleep=lambda s: None) is False
    joined = " ".join(said)
    assert "still terminating" in joined, joined
    assert "record is KEPT" in joined, "say what was NOT done"


def test_not_knowing_who_you_are_is_not_proof_the_namespace_is_yours(monkeypatch):
    """The owner comparison was `held_by and owner and held_by != owner`, so an empty
    owner skipped it.

    `_cli_actor()` returns "" until accounts exist -- team mode is opt-in -- so on a
    plain CLI box the check could not fire at all. Done on a live cluster: a namespace
    labelled `owner=bob` was adopted and Rocket.Chat installed into it.
    """
    from houston.errors import ConflictError
    from houston.services import k8s

    labels = {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
              k8s.WORKSPACE_LABEL: "w", k8s.OWNER_OF_LABEL: "bob"}
    # THE NAMESPACE DOCUMENT, because the preflight reads the phase as well as the
    # labels now and gets both from one `get namespace -o json`. Stubbing
    # `namespace_labels` no longer intercepts anything, and a stub that answers a call
    # the code does not make tests nothing.
    ns_doc = json.dumps({"metadata": {"name": "houston-w", "labels": labels},
                         "status": {"phase": "Active"}})
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: _completed(0, out=ns_doc))

    # THE REASON DEPENDS ON WHETHER TEAM MODE IS ON, and saying the wrong one made
    # the namespace un-adoptable. `_cli_actor()` returns "" whenever this box has no
    # accounts -- even with HOUSTON_USER set -- so on such a box the old message
    # said "HOUSTON_USER is not set" while it WAS, and the remedy it named produced
    # the identical refusal. The refusal itself was always right.
    with pytest.raises(ConflictError) as caught:
        k8s.assert_namespace_available("w", context="c")          # no owner at all
    assert "no houston accounts" in str(caught.value), caught.value
    assert "houston users add bob" in str(caught.value), \
        "the remedy has to be one that actually works on a box with no accounts"
    assert "HOUSTON_USER=bob" in str(caught.value), "say how to identify yourself"

    # With accounts, an empty owner really does mean the variable is unset, and the
    # original message is the right one.
    from houston.services import users as usersvc
    usersvc.add("someone", "correct-horse-battery")
    with pytest.raises(ConflictError) as caught:
        k8s.assert_namespace_available("w", context="c")
    assert "HOUSTON_USER is not set" in str(caught.value), caught.value
    assert "HOUSTON_USER=bob" in str(caught.value), "say how to identify yourself"

    with pytest.raises(ConflictError):
        k8s.assert_namespace_available("w", context="c", owner="alice")

    # bob himself is fine.
    k8s.assert_namespace_available("w", context="c", owner="bob")

    # And a namespace of bob's that is still going away is refused for a DIFFERENT
    # reason, with a different remedy: waiting, not identifying yourself.
    gone = json.dumps({"metadata": {"name": "houston-w", "labels": labels},
                       "status": {"phase": "Terminating"}})
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: _completed(0, out=gone))
    with pytest.raises(ConflictError) as terminating:
        k8s.assert_namespace_available("w", context="c", owner="bob")
    assert "Terminating" in str(terminating.value), terminating.value


def test_an_absent_namespace_is_confirmed_gone_not_a_failure(monkeypatch):
    """`delete_namespace` returned False when the namespace did not exist.

    `teardown` reads that as "not confirmed gone", keeps the local record and says so
    -- which means a Kubernetes record whose namespace has ALREADY been removed can
    never be deleted. `down --volumes` refuses it every time, for ever, and `list` goes
    on showing a workspace that is not there.

    Reached the moment a cluster is recreated: `prune` reclaims the kind cluster, the
    next `up` builds a new one, and every record from the old cluster is now immortal.
    Reported from a live box exactly that way -- the record dated three days earlier,
    the cluster's namespaces eight minutes old.

    Introduced by the change that gave `namespace_labels` three answers rather than
    two. Splitting "I could not ask" from "it is not there" was right; wiring the second
    into the failure branch beside it was not.
    """
    from houston.services import k8s

    # None = the namespace does not exist. (Cannot-ask RAISES, and still does.)
    monkeypatch.setattr(k8s.namespace, "namespace_labels", lambda ns, *, context: None)
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: True)

    assert k8s.delete_namespace("gone", context="c", volumes=True) is True, (
        "an absent namespace reported as not-confirmed-gone; the record can never go")

    # And the case this branch was written for is untouched: cannot-ask still raises,
    # so a wrong context or an RBAC denial never reads as "nothing to remove".
    #
    # `clusters()` is stubbed to report the cluster PRESENT. Without that, the
    # deleted-cluster path added later would see this box's real kind listing -- which
    # is empty -- prove the cluster gone and return True, which is right for a deleted
    # cluster and not what this half is about.
    from houston.errors import DockerError

    def cannot_ask(ns, *, context):
        raise DockerError("could not ask cluster 'c' about namespace")
    monkeypatch.setattr(k8s.namespace, "namespace_labels", cannot_ask)
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    try:
        k8s.delete_namespace("gone", context="c", volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("an unreachable cluster was treated as an absent namespace")
