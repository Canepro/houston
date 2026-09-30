"""The three-state Kubernetes answer must never collapse to a boolean."""
import pytest

from houston.services import k8s


def test_a_kubernetes_answer_cannot_be_collapsed_to_boolean():
    for state in (k8s.PRESENT, k8s.ABSENT, k8s.REFUSED):
        with pytest.raises(TypeError, match=r"present.*absent.*refused"):
            bool(k8s.Answer(state=state))
