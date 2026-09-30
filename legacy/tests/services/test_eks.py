"""`houston.services.eks`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from servicehelpers import _aws_ready
import json
import pytest
import subprocess


def test_a_missing_tool_does_not_also_complain_about_credentials(monkeypatch):
    """Blockers are ordered by what to do first, and stop at the first cause.

    Asking about credentials before `aws` exists produces a second complaint about the
    same absence -- and a report that lists three problems where there is one teaches
    the reader that the list is noise.
    """
    from houston.services import eks, k8s

    absent = k8s.Tool(name="aws", path="")
    pre = eks.CloudPreflight(tools={"aws": absent}, identity=eks.Identity(), region="")
    assert pre.blockers == ["aws is not installed"], pre.blockers
    assert pre.ready is False

    # With the tool there and no credentials, the credential blocker appears -- and it
    # names what to do rather than only what is wrong.
    present = k8s.Tool(name="aws", path="/usr/bin/aws", version=(2, 15))
    pre = eks.CloudPreflight(tools={"aws": present}, identity=eks.Identity(),
                             region="eu-west-1")
    assert len(pre.blockers) == 1 and "not signed in" in pre.blockers[0]
    assert "aws sso login" in pre.blockers[0]

    # A region is its own blocker: houston and eksctl resolving it differently means
    # a cluster somewhere neither of them will look for it afterwards.
    pre = eks.CloudPreflight(
        tools={"aws": present},
        identity=eks.Identity(account="1", arn="arn:aws:iam::1:user/x"), region="")
    assert len(pre.blockers) == 1 and "region" in pre.blockers[0]

    pre = eks.CloudPreflight(
        tools={"aws": present},
        identity=eks.Identity(account="1", arn="arn:aws:iam::1:user/x"),
        region="eu-west-1")
    assert pre.ready is True and pre.blockers == []


def test_a_new_vpc_by_default_and_an_existing_one_only_when_named():
    """The decision, and it is not symmetric.

    There is no safe guess at which of an account's subnets a support workspace
    belongs in, and picking wrong puts a cluster somewhere it can be reached from, or
    cannot reach out from, in ways nobody asked for. New is the answer that is wrong in
    the recoverable direction.
    """
    from houston.services import eks

    fresh = eks.cluster_config("rc-support", region="eu-west-1")
    assert fresh["vpc"] == {"cidr": eks.DEFAULT_VPC_CIDR}
    assert "subnets" not in fresh["vpc"], "a default create must not adopt a VPC"

    named = eks.cluster_config("rc-support", region="eu-west-1",
                               subnets={"eu-west-1b": "subnet-b",
                                        "eu-west-1a": "subnet-a"})
    assert named["vpc"]["subnets"]["private"] == {
        "eu-west-1a": {"id": "subnet-a"}, "eu-west-1b": {"id": "subnet-b"}}
    assert "cidr" not in named["vpc"], "naming subnets means NOT making a VPC"


def test_the_cluster_shape_matches_the_reference_it_claims_to_match():
    """Launchpad is the reference for what an EKS cluster must PROVIDE, so the
    numbers that carry fidelity are copied and the one that does not is not.

    Managed node group rather than Auto Mode, Kubernetes 1.33, t3.large, and the EBS
    CSI addon pinned to the version Launchpad pins -- those decide whether a
    reproduction behaves like the customer's cluster. Node COUNT does not, so it is
    the one deliberate divergence: Launchpad sizes for a production workspace and a
    repro carries one.
    """
    from houston.services import eks

    doc = eks.cluster_config("rc-support", region="us-east-1")
    assert doc["metadata"]["version"] == "1.33"
    assert doc["managedNodeGroups"][0]["instanceType"] == "t3.large"
    assert doc["addons"] == [{"name": "aws-ebs-csi-driver", "version": "1.47.0"}]
    assert doc["iam"]["withOIDC"] is True, \
        "without OIDC the EBS addon installs and every PVC stays Pending"
    assert "autoModeConfig" not in doc, "Auto Mode is not the reference shape"
    assert doc["managedNodeGroups"][0]["desiredCapacity"] == eks.DEFAULT_NODES == 3

    assert eks.cluster_config("x", region="us-east-1",
                              nodes=5)["managedNodeGroups"][0]["desiredCapacity"] == 5


def test_more_than_one_cloud_cluster_can_be_remembered(monkeypatch, tmp_path):
    """Two clusters is a name question, not a capacity one.

    `create_cluster` refuses a name that already exists in the region and nothing
    else, and the pointer is keyed on the name — so a second cluster under a second
    name is simply a second pointer, and `doctor` warns about both. Recorded because
    "one owned cloud cluster per home" was written down as a P2 non-goal, and the
    thing that would ENFORCE it does not exist: it is possible, it is just not
    designed for.
    """
    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eks.remember("support-a", region="us-east-1", account="1")
    eks.remember("support-b", region="eu-west-1", account="1")

    names = sorted(r["name"] for r in eks.remembered())
    assert names == ["support-a", "support-b"]
    assert {r["region"] for r in eks.remembered()} == {"us-east-1", "eu-west-1"}

    # Forgetting one leaves the other.
    eks.forget("support-a")
    assert [r["name"] for r in eks.remembered()] == ["support-b"]


def test_what_was_applied_to_a_cluster_is_written_down(monkeypatch, tmp_path):
    """Six weeks later the cluster is the only evidence and nobody remembers the flags.

    So the document eksctl was handed and the manifests applied afterwards are kept on
    this box. Two properties matter more than the writing itself:

    they survive a FAILED create -- which is precisely when somebody wants to read what
    was submitted, and when a temporary file would have taken the evidence with it;

    and they survive the DELETE. The pointer goes, because `doctor` warns from it and a
    warning must not outlive the cluster; the documents stay, because "what did we run
    in March" has nothing else to read.
    """
    import yaml

    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    kept = eks.keep_manifest("support", "cluster.yaml", yaml.safe_dump(
        eks.cluster_config("support", region="us-east-1")))
    assert kept is not None and kept.is_file()
    assert kept.parent == eks.cluster_dir("support")

    eks.remember("support", region="us-east-1", account="1")
    assert [r["name"] for r in eks.remembered()] == ["support"]

    eks.forget("support")
    assert eks.remembered() == [], "doctor must stop warning about a deleted cluster"
    assert kept.is_file(), "what was built is worth more after the fact than during"

    # An unwritable home is not a reason to refuse a create.
    monkeypatch.setattr(eks.runner.paths, "atomic_write",
                        lambda *a, **kw: (_ for _ in ()).throw(OSError("read-only")))
    assert eks.keep_manifest("support", "x.yaml", "body: 1") is None


def test_the_old_flat_pointer_is_still_read(monkeypatch, tmp_path):
    """A cluster created before manifests were kept must not vanish from `doctor`.

    The pointer moved from `clusters/<name>.json` to `clusters/<name>/cluster.json`,
    and the whole purpose of the warning it feeds is a cluster nobody is thinking about
    any more -- which is exactly the one that would be lost by a layout change.
    """

    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    old = tmp_path / "clusters"
    old.mkdir(parents=True)
    (old / "legacy.json").write_text(json.dumps(
        {"name": "legacy", "region": "eu-west-1", "account": "1", "provider": "eks"}))

    eks.remember("modern", region="us-east-1", account="1")
    assert sorted(r["name"] for r in eks.remembered()) == ["legacy", "modern"]

    # And forgetting the old-shaped one actually removes it.
    eks.forget("legacy")
    assert [r["name"] for r in eks.remembered()] == ["modern"]


def test_a_cluster_says_when_somebody_expected_to_be_finished_with_it():
    """A reminder, and deliberately nothing more.

    Nothing acts on this tag and in particular nothing deletes on it: removing a cloud
    cluster is minutes of destructive work on somebody's AWS account, and a timer is
    the worst possible thing to have decided it. On a shared cluster the namespaces
    may belong to colleagues on machines this box has never seen — the same argument
    the delete guards rest on.
    """
    import datetime as dt

    from houston.services import eks

    today = dt.date(2026, 9, 1)
    assert eks.expiry_date(7, today=today) == "2026-09-08"
    assert eks.expiry_date(0, today=today) == "2026-09-01"

    # `never` is a real answer, not a missing one. A cluster somebody means to keep
    # should be able to say so -- a reminder nobody can turn off is one everybody
    # learns to ignore, including for the clusters that matter.
    assert eks.expiry_date(None, today=today) == ""

    assert eks.days_until("2026-09-08", today=today) == 7
    assert eks.days_until("2026-08-25", today=today) == -7
    assert eks.days_until("", today=today) is None
    assert eks.days_until("not-a-date", today=today) is None

    # The tag rides in the ClusterConfig, so it is set AT creation like ownership --
    # there is no window in which the cluster exists without it.
    doc = eks.cluster_config("c", region="us-east-1", expires="2026-09-08")
    assert doc["metadata"]["tags"] == {
        eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE,
        eks.EXPIRY_TAG_KEY: "2026-09-08"}

    # And a cluster with no expiry carries no empty tag -- an absent tag and a tag
    # whose value is "" are different things to anything reading them later.
    assert eks.cluster_config("c", region="us-east-1")["metadata"]["tags"] == {
        eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE}


# --- the permissions documents are shipped, not described ----------------------------

def test_every_permissions_document_is_shipped_and_every_shipped_one_is_listed():
    """A registry and a directory that disagree is how a document goes missing.

    These are pasted into `aws iam create-policy` and `kubectl apply` by somebody
    setting houston up for the first time, so an entry naming a file that is not
    there fails at the worst possible moment -- and a file nobody lists is one nobody
    knows to use.
    """
    from importlib import resources

    from houston.services import eks

    shipped = {p.name for p in
               resources.files("houston").joinpath("data", "iam").iterdir()
               if p.is_file()}
    listed = {fname for fname, _ in eks.IAM_DOCUMENTS.values()}
    assert listed == shipped, (
        f"registry and data/iam disagree — only in registry: {sorted(listed - shipped)}, "
        f"only on disk: {sorted(shipped - listed)}")
    for key in eks.IAM_DOCUMENTS:
        assert eks.iam_document(key).strip(), f"{key} is shipped empty"


def test_the_permissions_documents_ship_in_a_wheel():
    """package-data is a glob somebody has to remember to widen.

    Without it the files are in the repo, every test passes, and they are simply
    absent from an installed houston -- which is the one place they matter, because
    the person running `cluster iam-policy` is setting up a machine that is not this
    one.
    """
    import re
    from pathlib import Path

    from houston.services import eks

    text = Path(eks.__file__).parents[2].joinpath("pyproject.toml").read_text()
    globs = re.findall(r'"(data/[^"]+)"', text)
    for fname, _ in eks.IAM_DOCUMENTS.values():
        suffix = fname.rsplit(".", 1)[-1]
        assert f"data/iam/*.{suffix}" in globs, (
            f"{fname} would not ship: pyproject package-data has no "
            f"data/iam/*.{suffix} glob")


def test_being_signed_in_to_aws_is_a_prerequisite_houston_reads_not_one_it_holds(
        monkeypatch):
    """Three states, because "no credentials" and "I could not find out" differ.

    Only one of them is the operator's to fix by signing in, and houston never stores
    or refreshes a credential -- it reads whatever `aws configure`, SSO, an instance
    profile or the environment already arranged. The identity is then carried into
    every message, because `cluster support` exists in more than one AWS account and
    acting on the wrong one is this feature's whole failure mode.
    """
    import subprocess

    from houston.services import eks, k8s

    # No `aws` at all: a tool problem, not a credentials problem.
    monkeypatch.setattr(k8s.tools, "which", lambda t: "")
    who = eks.whoami()
    assert not who.known and "not installed" in who.error

    # Present but refusing -- expired SSO, no profile, no route. AWS's own words are
    # kept, because they say which of those it was and houston cannot.
    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/aws")
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 255, "", "Error loading SSO Token: Token has expired"))
    who = eks.whoami()
    assert not who.known and "expired" in who.error

    # Signed in: the ARN and the ACCOUNT, both, and the account is the half that
    # stops a cluster being built in the wrong one.
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 0, '{"Account": "123456789012", '
                 '"Arn": "arn:aws:iam::123456789012:user/support-bot"}', ""))
    who = eks.whoami()
    assert who.known and who.account == "123456789012"
    assert "support-bot" in who.pretty and "123456789012" in who.pretty


def test_creating_a_cluster_is_gated_on_the_account_that_gets_the_bill(monkeypatch,
                                                                      tmp_path):
    """A GATE, not a confirmation, and keyed on the ACCOUNT rather than the name.

    The account is the thing that gets billed — the unit somebody actually owns and
    can consent to. And the gate carries `approve_with`, which is what to ask a human
    to run, never something the caller may run for itself.
    """
    from houston import errors
    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    spent: list = []
    monkeypatch.setattr(eks.k8s.kube, "run", lambda *a, **kw: spent.append(a) or None)

    with pytest.raises(errors.AuthorityGateError) as exc:
        eks.create_cluster("support")
    assert exc.value.code == "GATE_CLOUD_SPEND"
    assert "123456789012" in str(exc.value)
    assert "cluster.approved_accounts" in exc.value.approve_with
    assert not spent, "the gate must refuse BEFORE anything is run"

    # The gate is not reachable by --force anywhere: there is no such parameter on
    # create at all, which is the point. Approval is a decision, force is a reflex.
    import inspect
    assert "force" not in inspect.signature(eks.create_cluster).parameters


def test_an_approved_account_reaches_eksctl_with_the_right_command(monkeypatch,
                                                                  tmp_path):
    """What is actually run, asserted without running it.

    This is the expensive path's only unverifiable step, so the argv and the document
    handed to it are pinned here: everything up to the subprocess can be checked
    without an AWS account, which leaves "does eksctl behave as documented" as the
    single thing an account is needed for.
    """
    import yaml

    from houston import config
    from houston.services import eks, journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    config.update_config(
        lambda c: c.__setitem__(config.CLOUD_ACCOUNTS_KEY, "123456789012"))
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: eks.k8s.Answer(state=eks.k8s.ABSENT))

    seen: dict = {}

    def fake_stream(argv, **kw):
        seen["argv"] = list(argv)
        seen["timeout"] = kw.get("timeout")
        seen["doc"] = yaml.safe_load(open(argv[argv.index("-f") + 1]).read())
        # The note must be on disk WHILE eksctl runs -- that is its whole purpose.
        seen["note_during"] = [e.kind for e in journal.open_entries()]
        return 0

    # `_stream`, not `k8s.run`: the create switched to streaming so a twenty-minute
    # build reports progress, and a stub left on the old seam does not intercept --
    # this test then shelled out to REAL eksctl against REAL credentials.
    monkeypatch.setattr(eks.aws, "_stream", fake_stream)
    monkeypatch.setattr(eks.k8s.kube, "run", lambda *a, **kw: None)
    eks.create_cluster("support", nodes=3)

    assert seen["argv"][:4] == ["eksctl", "create", "cluster", "-f"]
    assert seen["timeout"] == eks.CLUSTER_CREATE_TIMEOUT
    assert seen["timeout"] > 900, \
        "a 15-25 minute create cannot run under a timeout built for a local one"
    assert journal.CLUSTER_UNFINISHED in seen["note_during"], \
        "the note has to be down BEFORE the call; written after, it describes nothing"
    assert not journal.open_entries(), "and cleared once eksctl returned"

    doc = seen["doc"]
    # The OWNERSHIP tag specifically, not the whole dict: this asserts that the thing
    # authorising a later delete is set at creation, and `==` also asserted that
    # nothing else may ever be tagged -- which broke the moment an expiry was added,
    # for a reason that has nothing to do with what this test is about.
    tags = doc["metadata"]["tags"]
    assert tags[eks.OWNED_TAG_KEY] == eks.OWNED_TAG_VALUE, \
        "tagged AT creation — a later tagging step has a window that crashes inside"
    assert eks.EXPIRY_TAG_KEY in tags, "and a create carries an expiry by default"
    assert doc["vpc"] == {"cidr": eks.DEFAULT_VPC_CIDR}
    assert eks.remembered()[0]["account"] == "123456789012"


def test_a_create_that_fails_keeps_the_note_that_says_it_may_be_billing(monkeypatch,
                                                                       tmp_path):
    """eksctl can build a VPC, a NAT gateway and a control plane and then fail.

    houston does not decide on its own to destroy those — so the note stays, and it
    is the note, not the exception, that survives the process ending.
    """
    from houston import config, errors
    from houston.services import eks, journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    config.update_config(
        lambda c: c.__setitem__(config.CLOUD_ACCOUNTS_KEY, "123456789012"))
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: eks.k8s.Answer(state=eks.k8s.ABSENT))
    monkeypatch.setattr(eks.aws, "_stream", lambda *a, **kw: 1)
    monkeypatch.setattr(eks.k8s.kube, "run", lambda *a, **kw: None)

    with pytest.raises(errors.CreateFailedError):
        eks.create_cluster("support")

    left = journal.open_entries()
    assert [e.kind for e in left] == [journal.CLUSTER_UNFINISHED]
    said = journal.describe(left[0])
    assert "BILLING NOW" in said
    assert "cloudformation describe-stacks" in said, \
        "the obvious `eksctl delete` is the advice that fails when a stack survives"
    assert "eu-west-1" in said and "123456789012" in said, \
        "a note that does not say where is unactionable"


def _the_four_refusals_a_delete_has_to_make(eks, errors, k8s, monkeypatch, ran, tags):
    """Unproven ownership, an unreadable cluster, somebody else's namespace, a workspace still on it."""
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "cannot prove" in str(exc.value)
    assert not ran, "nothing may be run on a read that failed"

    # GUARD 5b: present but NOT ours -> a gate, and GUARD 6: it names where.
    monkeypatch.setattr(eks.aws, "describe_cluster", tags({"someone": "else"}))
    with pytest.raises(errors.AuthorityGateError) as gate:
        eks.delete_cluster("support")
    assert gate.value.code == "GATE_DELETE_UNOWNED"
    assert "eu-west-1" in str(gate.value) and "123456789012" in str(gate.value)
    assert not ran

    ours = tags({eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE})
    monkeypatch.setattr(eks.aws, "describe_cluster", ours)

    # GUARD 1: unreadable is not empty -- and the refusal names WHICH kind of
    # unreadable, because "is not answering" was printed for an ACTIVE cluster whose
    # only problem was that this box had no kubeconfig entry for it.
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: False)
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DOWN))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "nothing answered" in str(exc.value) and "not an empty one" in str(exc.value)
    assert not ran

    # The SAME guard, the same refusal, a different cause -- and the advice differs.
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DENIED))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "refused these credentials" in str(exc.value), \
        "a cluster that answers and refuses is not a cluster that is down"
    assert "create-access-entry" in str(exc.value), \
        "and the advice must point at the access entry, not at the cluster's health"
    assert not ran

    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_OK))

    # GUARD 2: an unreadable workspace list is not an empty one.
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx: None)
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "could not be read" in str(exc.value)
    assert not ran

    # GUARD 3: non-empty refuses, and NAMES WHOSE -- on a shared cloud cluster this
    # refusal is the only record that colleagues on other boxes have work in here.
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx: ["houston-tkt-1"])
    monkeypatch.setattr(k8s.namespace, "namespace_owner", lambda ns, context: "priya")
    with pytest.raises(errors.ConflictError) as conf:
        eks.delete_cluster("support")
    assert "priya" in str(conf.value)
    assert not ran


def _an_aws_account_whose_every_call_is_recorded(monkeypatch, tmp_path):
    """A cloud that answers, with every command it was asked to run kept."""
    import subprocess

    from houston import errors
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    ran: list = []
    monkeypatch.setattr(eks.aws, "_stream",
                        lambda argv, **kw: ran.append(list(argv)) or 0)
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: ran.append(list(argv))
                        or subprocess.CompletedProcess(argv, 0, "", ""))

    def tags(value):
        doc = {"arn": "arn:aws:eks:eu-west-1:1:cluster/support"}
        if value is not None:
            doc["tags"] = value
        return lambda n, r: k8s.Answer(state=k8s.PRESENT, doc=doc)

    # GUARD 5a: the tag read REFUSED is not a yes.
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))
    return eks, errors, k8s, ran, tags


def test_deleting_a_cloud_cluster_reproduces_every_guard_the_local_one_earned(
        monkeypatch, tmp_path):
    """Each of these is a way this already went wrong once on a kind cluster, where
    the cost was a container rather than somebody's afternoon and a VPC.

    Plus two only the cloud needs: the tag must say ours, and the refusal must name the
    account and region -- a cluster called `support` exists in more than one account,
    and acting on the wrong one is this feature's whole failure mode.
    """
    eks, errors, k8s, ran, tags = _an_aws_account_whose_every_call_is_recorded(monkeypatch, tmp_path)
    _the_four_refusals_a_delete_has_to_make(eks, errors, k8s, monkeypatch, ran, tags)

    # GUARD 4: --force is the only override, and then it really does go.
    assert eks.delete_cluster("support", force=True) is True
    gone = ["eksctl", "delete", "cluster", "--name", "support",
            "--region", "eu-west-1", "--wait"]
    assert gone in ran, "--force is the override, and then it really does go"
    assert "--wait" in gone, \
        "without --wait eksctl returns before the teardown has actually happened"
    # AND THEN IT TIDIES, which is why that is no longer the LAST thing to run.
    # `aws eks update-kubeconfig` and `eksctl` each wrote a context naming this
    # cluster and neither removes it, so a cluster deleted successfully went on being
    # listed for ever. Those entries are houston's own litter and the delete clears
    # them -- after the cluster is gone, never before, so a delete that fails leaves
    # the operator still able to reach what they were deleting.
    after = ran[ran.index(gone) + 1:]
    assert any(c[:2] == ["kubectl", "config"] for c in after), \
        "the contexts naming a deleted cluster must be cleared with it"


def test_a_cluster_that_is_simply_gone_is_not_an_error(monkeypatch, tmp_path):
    """ABSENT is a fact AWS asserted, and deleting nothing is not a failure."""
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.ABSENT))
    assert eks.delete_cluster("support") is False


def test_creating_a_cluster_makes_it_the_default_and_deleting_it_takes_that_back(
        monkeypatch, tmp_path):
    """houston has just built this cluster and knows its ARN.

    Making the operator read it back out of `aws` and paste it into every later
    command is ceremony houston imposes on itself — and an ARN is the worst possible
    thing to ask somebody to retype.

    The delete has to put it back, or a `kubernetes.context` pointing at a cluster
    that no longer exists makes the next `up` fail on a context that cannot be found,
    which reads as a bug in `up` rather than the consequence of a delete.
    """
    from houston import config
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    arn = "arn:aws:eks:us-east-1:1:cluster/support"
    assert config.default_kube_context() == ""

    _aws_ready(monkeypatch)
    config.update_config(lambda c: c.__setitem__(config.CLOUD_ACCOUNTS_KEY,
                                                 "123456789012"))
    monkeypatch.setattr(eks.aws, "describe_cluster", lambda n, r: k8s.Answer(
        state=k8s.ABSENT) if not eks.__dict__.get("_made") else None)
    # Simplest faithful stand-in: absent before, present with an arn after.
    made = {"yes": False}

    def describe(n, r):
        if made["yes"]:
            return k8s.Answer(state=k8s.PRESENT, doc={"arn": arn})
        return k8s.Answer(state=k8s.ABSENT)

    monkeypatch.setattr(eks.aws, "describe_cluster", describe)
    monkeypatch.setattr(eks.aws, "_stream", lambda *a, **kw: made.__setitem__("yes", True) or 0)
    monkeypatch.setattr(eks.aws, "prepare_cluster", lambda ctx, emit=None: {})
    # A FAITHFUL DOUBLE: `k8s.run` returns a CompletedProcess, never None. The
    # create writes a per-cluster kubeconfig through it and reads `.returncode`
    # to decide whether the file is there to chmod.
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: subprocess.CompletedProcess(
        args=a[0] if a else [], returncode=0, stdout="", stderr=""))

    eks.create_cluster("support", region="us-east-1")
    assert config.default_kube_context() == arn, \
        "the cluster it just built should be the one `up` goes to"

    # And the delete takes it back.
    monkeypatch.setattr(eks.aws, "owns_cluster",
                        lambda n, r: k8s.Answer(state=k8s.PRESENT, doc={"arn": arn}))
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_OK))
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx: [])
    monkeypatch.setattr(eks.aws, "_stream", lambda *a, **kw: 0)
    eks.delete_cluster("support", region="us-east-1")
    assert config.default_kube_context() == "", \
        "a default pointing at a deleted cluster makes the next `up` fail obscurely"


# --- the command that looks where you are not already looking ------------------------

def test_a_cluster_in_a_region_nobody_named_is_still_found(monkeypatch):
    """Nothing else in houston can answer "what am I paying for".

    `cluster status` needs a context you already have and `doctor` reads a local
    pointer a fresh HOUSTON_HOME has not got, so a cluster in a region you have
    stopped thinking about is invisible to the entire tool. MEASURED: a cluster
    houston built sat in eu-west-1 for 16.8 hours and $2.47 while that day's checks
    swept only us-east-1, and it was found by an unrelated `aws` call.

    The ownership tag needed to find it had existed since the first cloud commit. What
    was missing was anything that went looking.
    """
    import types
    from houston.services import eks, k8s

    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/aws")

    def fake_run(argv, **kw):
        if "describe-regions" in argv:
            return types.SimpleNamespace(
                returncode=0, stdout='["us-east-1","eu-west-1","ap-south-1"]', stderr="")
        region = argv[argv.index("--region") + 1]
        if region == "eu-west-1":
            return types.SimpleNamespace(returncode=0, stdout='["support"]', stderr="")
        if region == "ap-south-1":                 # could not be asked at all
            return types.SimpleNamespace(
                returncode=255, stdout="", stderr="AccessDeniedException: no")
        return types.SimpleNamespace(returncode=0, stdout="[]", stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(eks.aws, "describe_cluster", lambda n, r: k8s.Answer(
        state=k8s.PRESENT,
        doc={"status": "ACTIVE", "arn": f"arn:aws:eks:{r}:1:cluster/{n}",
             "createdAt": "2026-09-01T11:03:00Z",
             "tags": {eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE,
                      eks.EXPIRY_TAG_KEY: "2026-09-08"}}))

    found = eks.sweep_clusters()
    names = [(c["region"], c["name"]) for c in found["clusters"]]
    assert names == [("eu-west-1", "support")], \
        "the sweep must find a cluster in a region the caller never named"
    assert found["clusters"][0]["expires"] == "2026-09-08"

    # AND A REGION THAT COULD NOT BE ASKED IS NOT A REGION WITH NOTHING IN IT. This is
    # the whole discipline of the module: a report that let fourteen refused regions
    # read as "you are paying for nothing" would be worse than no report at all.
    assert [b["region"] for b in found["unreadable"]] == ["ap-south-1"]
    assert "AccessDenied" in found["unreadable"][0]["why"]


def test_a_cluster_that_is_there_and_cannot_be_described_is_never_silently_dropped(monkeypatch):
    """`list-clusters` named it, so it EXISTS. Failing to describe it is not absence."""
    import types
    from houston.services import eks, k8s

    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/aws")
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: types.SimpleNamespace(
        returncode=0,
        stdout='["us-east-1"]' if "describe-regions" in argv else '["ghost"]',
        stderr=""))
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))

    found = eks.sweep_clusters()
    assert found["clusters"] == []
    assert found["unreadable"] and "ghost" in found["unreadable"][0]["why"], \
        "a cluster that exists and could not be read must be reported, never dropped"


def test_the_two_permissions_nobody_would_guess_are_still_in_the_policy():
    """Both were found by a live create FAILING without them, twenty minutes in.

    `ec2:RunInstances` is the counter-intuitive one: EKS starts the nodes itself, and
    still checks that the CALLER could have launched them with the node group's
    launch template. A policy without it builds a cluster with ZERO NODES that bills
    at the full rate and can run nothing.
    `cloudformation:UpdateTerminationProtection` fails only on the delete path, and
    only after the cluster is already half removed.

    Neither is obvious from reading the policy, so this is the test that stops a
    tidy-up removing them.
    """
    import json

    from houston.services import eks

    doc = json.dumps(json.loads(eks.iam_document("operator")))
    assert "ec2:RunInstances" in doc, \
        "without it, `cluster create` produces a cluster with no nodes that still bills"
    assert "cloudformation:UpdateTerminationProtection" in doc, \
        "without it, `cluster delete` fails after the cluster is half gone"


def test_the_engineer_rbac_grants_the_cluster_scoped_things_aws_own_policy_omits():
    """`AmazonEKSAdminPolicy` is admin INSIDE a namespace and stops exactly there.

    houston crosses that line on every `up`: a namespace per workspace is the whole
    model, and a namespace is cluster-scoped. MEASURED against a live cluster -- with
    only the AWS managed policy, `up` failed twice, first unable to read StorageClasses
    and then unable to create the namespace at all.
    """
    import yaml

    from houston.services import eks

    docs = [d for d in yaml.safe_load_all(eks.iam_document("rbac")) if d]
    role = next(d for d in docs if d["kind"] == "ClusterRole")
    binding = next(d for d in docs if d["kind"] == "ClusterRoleBinding")

    def verbs(resource: str) -> set[str]:
        out: set[str] = set()
        for rule in role["rules"]:
            if resource in rule["resources"]:
                out |= set(rule["verbs"])
        return out

    assert {"create", "delete"} <= verbs("namespaces"), \
        "a namespace per workspace is the model, and AmazonEKSAdminPolicy cannot make one"
    assert "list" in verbs("storageclasses"), \
        "`up` reads StorageClasses before it creates anything and refuses without them"
    # Everything ELSE stays read-only: an engineer runs workspaces and does not
    # reshape the cluster they are running them in.
    for rule in role["rules"]:
        if "namespaces" in rule["resources"]:
            continue
        assert set(rule["verbs"]) <= {"get", "list", "watch"}, \
            f"{rule['resources']} grants more than a read: {rule['verbs']}"
    assert binding["subjects"][0]["name"] == "houston-engineers", \
        "the binding must name the group the EKS access entry puts people in"


def test_the_guide_path_is_the_real_file_even_through_a_symlinked_data_directory(tmp_path, monkeypatch):
    """Since Phase 9.0 the package reaches `data/` through the `houston/data` symlink, so the
    Traversable `resources.files` hands back names a path THROUGH the link. `cluster guide
    --path` printed that path while the TypeScript build, which owns data/, printed the real
    one: two answers for one file. The printed path is the file's real location."""
    import importlib.resources
    from houston.services import eks_docs

    real = tmp_path / "real" / "data" / "docs"
    real.mkdir(parents=True)
    (real / eks_docs.GUIDE_FILE).write_text("# guide\n", encoding="utf-8")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "data").symlink_to(tmp_path / "real" / "data")
    monkeypatch.setattr(importlib.resources, "files", lambda package: tmp_path / "pkg")

    found = eks_docs.guide_path()
    assert found is not None
    assert str(found) == str((real / eks_docs.GUIDE_FILE).resolve()), (
        f"{found} goes through the symlink; the real file is {(real / eks_docs.GUIDE_FILE).resolve()}")


def test_the_readme_points_at_the_guide_that_actually_exists():
    """The README stopped repeating the walkthrough and links to it instead.

    That is the right call -- a 190-line procedure kept in two places is a procedure
    that will disagree with itself -- and it is only the right call while the link
    resolves.
    """
    from pathlib import Path

    from houston.services import eks

    root = Path(eks.__file__).parents[3]      # legacy/houston/services/eks.py -> the repository
    readme = root.joinpath("README.md").read_text()
    assert "data/docs/eks.md" in readme, \
        "the README must say where the EKS walkthrough went"
    assert root.joinpath("data/docs/eks.md").is_file(), \
        "and the path it names has to be there"
    assert "houston cluster guide" in readme


def test_the_documents_the_facade_re_exports_are_the_ones_that_are_tested():
    """`eks.iam_document` must BE `eks_docs.iam_document`, not a second copy.

    Two implementations behind one name is how the CLI and the GUI would start
    printing different permissions for the same cluster.
    """
    from houston.services import eks, eks_docs

    assert eks.iam_document is eks_docs.iam_document
    assert eks.IAM_DOCUMENTS is eks_docs.IAM_DOCUMENTS
