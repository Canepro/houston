"""Portable object-property contracts for the AWS orchestration seam."""

from houston.services import eks, k8s


def test_the_aws_seam_is_a_live_exported_property(monkeypatch):
    seen = []

    def describe(name, region):
        seen.append((name, region))
        return k8s.Answer(state=k8s.PRESENT, doc={"name": name})

    monkeypatch.setattr(eks.aws, "describe_cluster", describe)

    answer = eks.cluster_exists("support", "us-east-1")
    assert answer.present and answer.doc == {"name": "support"}
    assert seen == [("support", "us-east-1")]
