"""The EKS walkthrough houston ships, and the permissions it tells you to grant.

The only part of the EKS work that asks AWS nothing: static text, a file on disk,
and a table of documents somebody has to approve before any of the rest can run.
Every other section of `eks.py` reaches the `aws` property bag that module builds
at the bottom, so moving one of those would import back into it; this one does not,
which is what makes it the seam that takes the module back under its line cap.
"""
from __future__ import annotations


from houston.errors import PreflightError, ValidationError


#: The documents that let a NON-ROOT identity run houston against EKS, shipped rather
#: than described. Each was verified by using it: an IAM user holding only
#: `operator-policy.json` built a cluster, ran a workspace on it and deleted it, and
#: the two permissions in it that nobody would guess -- `ec2:RunInstances`, which EKS
#: checks against the CALLER even though EKS launches the nodes, and
#: `cloudformation:UpdateTerminationProtection`, which fails only on delete and only
#: after the cluster is half gone -- are there because a live run failed without them.
#:
#: SHIPPED, not documented. A policy that lives in a design note is a policy somebody
#: retypes, and a retyped policy is one of these two actions short -- which produces a
#: cluster with zero nodes that bills at full rate and cannot run anything.
IAM_DOCUMENTS: dict[str, tuple[str, str]] = {
    "operator": ("operator-policy.json",
                 "AWS permissions to CREATE and DELETE clusters. Too long for an "
                 "inline user policy (2,048 chars) — attach it as a customer-managed "
                 "policy, or inline on a role, which allows 10,240."),
    "engineer": ("engineer-policy.json",
                 "AWS permissions to USE a cluster somebody else built. Two read "
                 "actions, and NOT sufficient on its own — see `rbac` below."),
    "rbac": ("engineer-rbac.yaml",
             "Kubernetes permissions for the same person. IAM gets them a kubeconfig; "
             "the cluster then refuses it until an EKS access entry exists. Apply this "
             "once per cluster, as the cluster's creator."),
}


#: The end-to-end EKS walkthrough, shipped rather than left in a repository somebody
#: may not have. The person most likely to need it is setting houston up on a machine
#: that is not the one it was developed on, and "read the README on GitHub" is a poor
#: answer when the tool is already installed in front of them.
GUIDE_FILE = "eks.md"


def guide_path():
    """Where the shipped EKS guide is on this machine, or None if it is not there.

    The REAL file, with symlinks resolved. Since Phase 9.0 the package reaches `data/`
    through the `houston/data` link, and a path through the link is one a reader cannot
    `git log` and one the TypeScript build, which owns `data/`, never prints -- so the two
    builds disagreed about where the same file was. An installed wheel has no link, and
    resolving is the identity there.
    """
    import pathlib
    from importlib import resources
    path = pathlib.Path(str(resources.files("houston").joinpath("data", "docs", GUIDE_FILE)))
    return path.resolve() if path.is_file() else None


def guide() -> str:
    """The EKS walkthrough, verbatim."""
    path = guide_path()
    if path is None:
        raise PreflightError(
            f"{GUIDE_FILE} is missing from this install. It is shipped package data, "
            f"so this is a broken or stale editable install — `pip install -e .` "
            f"re-links it.")
    return path.read_text(encoding="utf-8")


def iam_document(which: str) -> str:
    """One shipped permissions document, verbatim.

    Verbatim matters more than it looks: this text is pasted into `aws iam
    create-policy` and `kubectl apply`, so anything houston added to be helpful --
    a header, a trailing note, a reformat -- is a syntax error in somebody's terminal.
    """
    entry = IAM_DOCUMENTS.get(which)
    if not entry:
        raise ValidationError(
            f"unknown permissions document {which!r}. Want: "
            + " | ".join(sorted(IAM_DOCUMENTS)) + ".")
    from importlib import resources
    path = resources.files("houston").joinpath("data", "iam", entry[0])
    if not path.is_file():
        raise PreflightError(
            f"{entry[0]} is missing from this install. It is shipped package data, so "
            f"this is a broken or stale editable install — `pip install -e .` re-links "
            f"it.")
    return path.read_text(encoding="utf-8")
