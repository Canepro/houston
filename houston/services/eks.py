"""The AWS seam. Everything that speaks to AWS rather than to a cluster.

`k8s` stays the only Kubernetes seam: this module asks AWS who you are and, later,
asks `eksctl` to build a cluster, and everything that talks to a cluster once it
exists goes through `k8s` unchanged. The same relationship `runner` has with Docker
and `rcapi` has with Rocket.Chat.

**Credentials are never houston's to hold.** Being logged in to AWS is a
PREREQUISITE, exactly as having Docker running is: the operator arranges it with
`aws configure`, SSO, an instance profile or environment variables, and houston
reads the ambient result and names what it found. Nothing here stores, prompts for,
refreshes or writes a credential. That is also what makes an adopted EKS cluster work
at all -- `aws eks update-kubeconfig` writes a kubeconfig whose user runs `aws eks
get-token`, so `kubectl` itself needs those same ambient credentials, and
`k8s.run()` passes the environment through untouched for any cluster houston does
not own.

**The identity is reported, not just checked.** A refusal that says "not logged in"
is half an answer; a confirmation that says "ready" is worse. `cluster support` exists
in more than one AWS account, and the whole failure mode of this feature is acting on
the wrong one -- so the account id and the caller ARN are carried on every answer and
belong in every message that follows.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from houston import config, runner
from houston.errors import (AuthorityGateError, ConflictError, CreateFailedError,
                             DockerError, PreflightError, ValidationError)
from houston.services import journal, k8s
from houston.services.events import Emit, info, null_emit, warn

#: What talking to AWS needs, and it is not the same question as what BUILDING a
#: cluster needs. `aws` alone is enough to authenticate against an EKS cluster
#: somebody else made -- that is the exec credential plugin in the kubeconfig -- while
#: `eksctl` is only ever needed to create or destroy one. Kept apart so a box set up
#: to USE an EKS cluster is never told it is missing a provisioning tool it will never
#: run.
IDENTITY_TOOL = "aws"

#: Seconds. An `sts` call is one round trip to a public endpoint; a box with no route
#: to it should answer "I could not ask" quickly rather than hang a `doctor`.
IDENTITY_TIMEOUT = 15.0


@dataclass
class Identity:
    """Who AWS says you are, or why it could not say.

    Three states, not two, for the reason `k8s.Answer` gives: "there are no
    credentials" and "I could not find out whether there are credentials" are
    different facts, and only one of them is the operator's to fix by logging in.
    `error` distinguishes them -- empty with no account means a clean "not logged
    in", non-empty means the question failed.
    """
    account: str = ""
    arn: str = ""
    error: str = ""

    @property
    def known(self) -> bool:
        return bool(self.account)

    @property
    def pretty(self) -> str:
        """How the identity is named in every message that mentions it."""
        if not self.known:
            return "not signed in"
        who = self.arn.rsplit("/", 1)[-1] if "/" in self.arn else self.arn
        return f"{who} in account {self.account}"


def whoami(timeout: float = IDENTITY_TIMEOUT) -> Identity:
    """Ask AWS who this box is acting as. Never raises.

    `sts get-caller-identity` is the right question because it is the only one that
    needs no permissions beyond having credentials at all -- anything else would
    conflate "not signed in" with "signed in and not allowed to do that", which are
    different problems with different fixes.
    """
    if not k8s.which(IDENTITY_TOOL):
        return Identity(error=f"{IDENTITY_TOOL} is not installed")
    res = k8s.run([IDENTITY_TOOL, "sts", "get-caller-identity", "--output", "json"],
                  timeout=timeout)
    if res.returncode != 0:
        # Expired SSO, no profile, no route to STS -- all land here, and the text AWS
        # prints is far more useful than any sentence houston could substitute.
        return Identity(error=k8s.why(res, limit=200))
    try:
        doc = json.loads(res.stdout or "{}")
    except ValueError:
        return Identity(error="sts returned something that is not JSON")
    return Identity(account=str(doc.get("Account") or ""),
                    arn=str(doc.get("Arn") or ""))


def region() -> str:
    """The region this box would use, or "".

    Read the way the AWS tooling itself resolves it -- environment first, then the
    configured profile -- so houston and `eksctl` cannot disagree about where a
    cluster is about to be built. A cluster in the wrong region is not a small
    mistake: it is invisible to every command afterwards, which all default to the
    same resolution.
    """
    for var in ("AWS_REGION", "AWS_DEFAULT_REGION"):
        found = os.environ.get(var, "").strip()
        if found:
            return found
    if not k8s.which(IDENTITY_TOOL):
        return ""
    res = k8s.run([IDENTITY_TOOL, "configure", "get", "region"],
                  timeout=IDENTITY_TIMEOUT)
    return (res.stdout or "").strip() if res.returncode == 0 else ""


@dataclass
class CloudPreflight:
    """Whether this box could build an EKS cluster, and what is stopping it.

    Reports; never raises and never refuses. `doctor` renders it and the create path
    turns `blockers` into one refusal -- the same division `k8s.Preflight` already
    has, and for the same reason: the command someone runs when things are wrong must
    not be the command that falls over.
    """
    tools: dict[str, k8s.Tool] = field(default_factory=dict)
    identity: Identity = field(default_factory=Identity)
    region: str = ""

    @property
    def ready(self) -> bool:
        return not self.blockers

    @property
    def blockers(self) -> list[str]:
        """Everything that would stop a create, each phrased as its own remedy.

        Ordered by what to do first: a missing tool cannot be diagnosed further, and
        asking about credentials before `aws` exists produces a confusing second
        complaint about the same absence.
        """
        out: list[str] = []
        for name, found in sorted(self.tools.items()):
            if not found.present:
                out.append(f"{name} is not installed")
            elif not found.new_enough:
                floor = k8s.TOOLS.get(name) or ()
                want = ".".join(str(part) for part in floor) or "a newer release"
                out.append(f"{name} {found.pretty} is older than {want}")
        if any("not installed" in b for b in out):
            return out
        if not self.identity.known:
            out.append(
                "not signed in to AWS"
                + (f" ({self.identity.error})" if self.identity.error else "")
                + ". houston never holds AWS credentials — arrange them with "
                  "`aws configure`, `aws sso login`, an instance profile or the "
                  "standard environment variables, and it will use what it finds.")
        if not self.region:
            out.append(
                "no AWS region resolved. Set one with `aws configure set region "
                "<region>` or `AWS_REGION`, so houston and eksctl cannot disagree "
                "about where a cluster is being built.")
        return out


def preflight() -> CloudPreflight:
    """Everything the cloud path needs, in one pass, changing nothing.

    CONCURRENTLY, because this is the slowest thing `doctor` does and almost all of it
    is waiting. MEASURED on this box: `aws sts get-caller-identity` 1191ms, `aws
    configure get region` 301ms, `aws --version` 291ms -- 1783ms of a 2485ms report,
    and every one of them a separate process start or network round trip that has
    nothing to say to the others.

    Two waves, because `whoami` needs to know whether `aws` is installed before it is
    worth asking who you are. Within each wave nothing depends on anything else.
    """
    names = list(dict.fromkeys([*k8s.CLOUD_PROVISION_TOOLS, IDENTITY_TOOL]))
    with ThreadPoolExecutor(max_workers=max(2, len(names) + 1)) as pool:
        probed = dict(zip(names, pool.map(k8s.tool, names)))
        # `region` does not depend on the identity, so it runs beside it rather than
        # after it -- 301ms that used to be added to the 1191ms instead of hidden by it.
        f_region = pool.submit(region)
        ident = (whoami() if probed[IDENTITY_TOOL].present
                 else Identity(error=f"{IDENTITY_TOOL} is not installed"))
        return CloudPreflight(tools=probed, identity=ident, region=f_region.result())


#: Cluster ownership, by the same rule as namespace ownership and for the same
#: reason. `k8s.OWNER_LABEL_KEY` says it first -- anyone can create a namespace called
#: `houston-anything`, and a teardown that matched on the prefix would eventually
#: delete one houston never made. A cluster NAME is likewise the operator's choice,
#: and the stakes here are a VPC and a NAT gateway rather than a container.
#:
#: The tag lives ON THE CLUSTER, in AWS, and not in HOUSTON_HOME. CLAUDE.md tells
#: anyone writing a script to `export HOUSTON_HOME=$(mktemp -d)`, so a local
#: ownership record is one followed instruction away from leaving a billable cluster
#: houston can no longer prove is its own. A tag survives a lost home, a different
#: machine and a colleague.
OWNED_TAG_KEY = "houston.io/managed-by"
OWNED_TAG_VALUE = "houston"

#: When somebody said they would be finished with this cluster. A REMINDER, never a
#: policy: nothing acts on it, and in particular nothing deletes on it. Removing a
#: cloud cluster is minutes of destructive work on somebody's AWS account, and a timer
#: is the worst possible thing to have decided it -- on a shared cluster the
#: namespaces may belong to colleagues on machines this box has never seen, which is
#: the same argument the delete guards are built on.
#:
#: An ISO date, tagged ON the cluster so it survives a lost HOUSTON_HOME, and copied
#: into the local pointer so `doctor` can mention it without an AWS round trip -- the
#: same split ownership already uses, and for the same reason.
EXPIRY_TAG_KEY = "houston.io/expires"

#: Days, and short on purpose. The safe case is the default: a reproduction cluster is
#: wanted for a ticket, not a quarter, and the failure this guards against is the one
#: nobody notices -- a cluster at roughly $0.24/hr is about $175 a month, which is a
#: sum that turns up on a bill long after the person who made it has moved on.
#: A cluster meant to last says so explicitly with `--expires never`.
DEFAULT_EXPIRY_DAYS = 7

#: Seconds, and its own tier because nothing else in the product waits this long.
#: `eksctl create cluster` is 15-25 minutes; k8s.CREATE_TIMEOUT is 600 and would kill
#: a create most of the way through building a VPC, which is the worst possible moment.
CLUSTER_CREATE_TIMEOUT = 3000.0
#: `--wait` is not optional on delete, so this has to outlast a full teardown.
CLUSTER_DELETE_TIMEOUT = 2400.0


# --- the cluster shape -------------------------------------------------------------

#: Copied from Rocket.Chat's own Launchpad, which is the reference for what an EKS
#: cluster running Rocket.Chat must PROVIDE. Not for what runs inside it: houston
#: already installs its own ingress, cert-manager, Mongo operator and monitoring, and
#: Launchpad's `launchcontrol` is closed-source and labelled Alpha. It is a statement
#: of cluster requirements, not an architecture to inherit.
#:
#: Managed node group, NOT EKS Auto Mode, and the reason is what houston is for.
#: houston already runs Kubernetes on a local kind cluster -- free, about a minute.
#: If a bug were application-level, that reproduces it. Spending twenty minutes and
#: real money only makes sense when something ABOUT EKS matters to the ticket: an EBS
#: volume that will not bind, an ALB behaving unlike an ingress, scheduling under node
#: pressure. Auto Mode abstracts exactly those differently -- its own storage class
#: and driver, Karpenter-based nodes, its own load balancing -- so it would hide the
#: class of difference this feature exists to expose, and diverge from what a customer
#: following the official documentation is actually running.
K8S_VERSION = "1.33"
NODE_INSTANCE_TYPE = "t3.large"          # Launchpad's stated minimum
EBS_CSI_ADDON_VERSION = "1.47.0"         # Launchpad pins this exact version
DEFAULT_VPC_CIDR = "10.0.0.0/16"

#: Launchpad sizes for a PRODUCTION workspace: 5 nodes with its built-in MongoDB, 3
#: with an external one. A reproduction carries ONE workspace, and fidelity comes from
#: the addons, the Kubernetes version and the storage driver rather than from how many
#: nodes there are -- so this is the one place houston deliberately departs from the
#: reference, and `--nodes` raises it when a ticket is about scheduling or capacity.
#: Written down because an undocumented divergence is indistinguishable from a mistake.
DEFAULT_NODES = 3


def expiry_date(days: int | None, *, today: _dt.date | None = None) -> str:
    """The date this cluster says it is wanted until, or "" for no expiry.

    `None` days means never, and that is a real answer rather than a missing one: a
    cluster somebody intends to keep should be able to say so, and a reminder nobody
    can turn off is a reminder everybody learns to ignore.
    """
    if days is None:
        return ""
    base = today or _dt.date.today()
    return (base + _dt.timedelta(days=max(0, days))).isoformat()


def days_until(expires: str, *, today: _dt.date | None = None) -> int | None:
    """Days left, negative once past, or None when there is no expiry to compare."""
    if not expires:
        return None
    try:
        when = _dt.date.fromisoformat(expires)
    except ValueError:
        return None
    return (when - (today or _dt.date.today())).days


def cluster_config(name: str, *, region: str, nodes: int = DEFAULT_NODES,
                   subnets: dict[str, str] | None = None,
                   expires: str = "",
                   vpc_cidr: str = DEFAULT_VPC_CIDR) -> dict:
    """The eksctl ClusterConfig for a cluster houston would build.

    Pure: builds a document and touches nothing. That is deliberate and is what makes
    the expensive path testable -- every decision about the shape of a cluster can be
    asserted without an AWS account, leaving only the `eksctl` invocation itself
    unverifiable without one.

    **A NEW VPC BY DEFAULT, an existing one only when asked for by name.** Defaulting
    the other way is not available: there is no safe guess at which of an account's
    subnets a support workspace belongs in, and picking wrong puts a cluster somewhere
    it can be reached from, or cannot reach out from, in ways nobody asked for. New is
    the answer that is wrong in the recoverable direction -- `cluster delete` takes a
    VPC houston made back with it, and will not touch one it did not.
    """
    doc: dict = {
        "apiVersion": "eksctl.io/v1alpha5",
        "kind": "ClusterConfig",
        # THE TAG IS SET AT CREATION, not afterwards. A separate tagging step has a
        # window in which the cluster exists and is not yet provably houston's, and a
        # crash inside that window leaves something billable that `cluster delete`
        # will then correctly refuse to remove. eksctl applies `metadata.tags` to the
        # cluster itself, so there is no window.
        "metadata": {"name": name, "region": region, "version": K8S_VERSION,
                     "tags": {OWNED_TAG_KEY: OWNED_TAG_VALUE,
                              **({EXPIRY_TAG_KEY: expires} if expires else {})}},
        "managedNodeGroups": [{
            "name": f"{name}-ng",
            "instanceType": NODE_INSTANCE_TYPE,
            "desiredCapacity": nodes,
            "privateNetworking": True,
            "iam": {"withAddonPolicies": {"ebs": True}},
        }],
        "addons": [{"name": "aws-ebs-csi-driver",
                    "version": EBS_CSI_ADDON_VERSION}],
        # Every workspace PVC lands on EBS, so the driver needs to assume a role;
        # without OIDC the addon installs and the volumes stay Pending, which is the
        # single most confusing way for this to fail.
        "iam": {"withOIDC": True},
    }
    if subnets:
        # NAMED subnets, never discovered. houston is not going to guess which of an
        # account's subnets it is welcome in, and a wrong guess is a cluster in the
        # wrong place rather than an error.
        doc["vpc"] = {"subnets": {"private": {
            zone: {"id": sid} for zone, sid in sorted(subnets.items())}}}
    else:
        doc["vpc"] = {"cidr": vpc_cidr}
    return doc


def _stream(argv: list[str], *, phase: str, emit: Emit,
            timeout: float) -> int:
    """Run a long command and report what it says WHILE it says it.

    `k8s.run` captures output and returns it at the end, which is right for a probe
    that answers in a second and wrong for one that takes twenty minutes: `cluster
    create` printed one line and then went silent for the entire build, which is
    indistinguishable from a hang. Somebody watching that has no way to tell a cluster
    being built from a process that has stopped, and the only safe assumption -- kill
    it -- is the one that leaves a half-built VPC behind.

    eksctl writes its progress to STDERR, so both streams are merged rather than only
    stdout being read; and lines are emitted as they arrive rather than buffered,
    because a progress report delivered at the end is not a progress report.
    """
    seen: list[str] = []
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1,
                                env=k8s.user_env())
    except (OSError, subprocess.SubprocessError) as exc:
        warn(emit, f"{argv[0]} could not be started: {exc}", phase=phase)
        return 127
    started = time.monotonic()
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if not line:
            continue
        seen.append(line)
        # eksctl prefixes its own progress with a level and a timestamp; the message
        # is the part worth showing, and the rest is noise on a terminal that already
        # has its own clock.
        shown = line.split("]", 1)[-1].strip() if line.startswith(("[", "2")) else line
        info(emit, shown[:200], phase=phase)
        if time.monotonic() - started > timeout:
            proc.kill()
            warn(emit, f"{argv[0]} exceeded {timeout / 60:.0f} minutes and was stopped",
                 phase=phase)
            break
    proc.wait()
    if proc.returncode != 0:
        for line in seen[-6:]:
            warn(emit, line[:200], phase=phase)
    return proc.returncode


# --- what AWS says about a cluster -------------------------------------------------

def describe_cluster(name: str, region: str) -> k8s.Answer:
    """What AWS knows about one cluster: PRESENT with `.doc`, ABSENT, or REFUSED.

    THREE answers, and this is the highest-stakes use of that contract in the product.
    Everything destructive below reads it, and the two negatives must not be collapsed:
    `ResourceNotFoundException` is AWS asserting the cluster is not there, which is
    safe to act on; anything else -- expired credentials, no route, a throttle, a
    permission boundary -- is "I could not ask", which is not.
    """
    if not k8s.which(IDENTITY_TOOL) or not region:
        return k8s.Answer(state=k8s.REFUSED)
    res = k8s.run([IDENTITY_TOOL, "eks", "describe-cluster", "--name", name,
                   "--region", region, "--output", "json"],
                  timeout=IDENTITY_TIMEOUT)
    if res.returncode == 0:
        try:
            return k8s.Answer(state=k8s.PRESENT,
                              doc=json.loads(res.stdout or "{}").get("cluster") or {})
        except ValueError:
            return k8s.Answer(state=k8s.REFUSED, res=res)
    if "ResourceNotFoundException" in (res.stderr or ""):
        return k8s.Answer(state=k8s.ABSENT, res=res)
    return k8s.Answer(state=k8s.REFUSED, res=res)


def cluster_exists(name: str, region: str) -> k8s.Answer:
    """Whether a cluster by this name is there at all, tag or no tag.

    Separate from `owns_cluster` because they are different questions with different
    consequences. "Is it there" decides whether an interruption note is still worth
    keeping; "is it ours" decides whether it may be destroyed. Answering the second
    where the first was asked would clear the note about a half-built cluster that
    never got its tag on -- which is exactly the cluster the note exists for.
    """
    return describe_cluster(name, region)


def owns_cluster(name: str, region: str) -> k8s.Answer:
    """Whether houston may DESTROY this cluster. Never a name comparison.

    ABSENT means "not ours, refuse". REFUSED means "could not read, ALSO refuse" --
    the two behave the same way here and that is deliberate: the one thing that must
    never happen is a delete authorised by a read that failed. They are still
    distinguished in the return value, because the refusal has to say which it was.
    """
    seen = describe_cluster(name, region)
    if not seen.present:
        return seen
    tags = (seen.doc or {}).get("tags") or {}
    if str(tags.get(OWNED_TAG_KEY) or "") == OWNED_TAG_VALUE:
        return seen
    return k8s.Answer(state=k8s.ABSENT, doc=seen.doc)


# --- the permissions somebody has to grant before any of this works ------------------

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
    """Where the shipped EKS guide is on this machine, or None if it is not there."""
    from importlib import resources
    path = resources.files("houston").joinpath("data", "docs", GUIDE_FILE)
    return path if path.is_file() else None


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


# --- finding clusters nobody remembers -----------------------------------------------

#: Where to look when the account cannot be asked what it has enabled. A SHIPPED LIST
#: rather than a probe, because the probe needs `ec2:DescribeRegions` and the whole
#: point of this sweep is that it must work for the person who has least reason to
#: have it -- somebody checking what they are being charged for. Commercial regions
#: only: China and GovCloud are separate partitions with their own credentials, and a
#: sweep that pretended to cover them would report "nothing found" for an account it
#: could never have reached.
DEFAULT_REGION_SWEEP = (
    "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "ca-central-1", "sa-east-1",
    "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
    "eu-south-1",
    "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
    "ap-northeast-2", "ap-northeast-3", "ap-east-1",
    "me-south-1", "af-south-1",
)

#: Seconds for one region's `list-clusters`. Short: a sweep is many of these in a row
#: and one unreachable region must not hold the whole report.
SWEEP_TIMEOUT = 20.0


def enabled_regions() -> tuple[list[str], str]:
    """(regions to sweep, why the account could not be asked).

    Asks the account which regions it has enabled, because sweeping twenty-one when
    four are on is twenty-one round trips to answer a question about four. Falls back
    to the shipped list rather than refusing -- `ec2:DescribeRegions` is not in the
    minimal engineer policy, and the person most likely to be missing it is exactly
    the person who needs to know what is running.

    The second value is not decoration. A sweep that fell back covers the shipped list
    and NOT necessarily the account's actual regions, so a caller reporting "nothing
    found" has to be able to say which of the two questions it answered.
    """
    if not k8s.which(IDENTITY_TOOL):
        return list(DEFAULT_REGION_SWEEP), f"{IDENTITY_TOOL} is not installed"
    res = k8s.run([IDENTITY_TOOL, "ec2", "describe-regions",
                   "--query", "Regions[].RegionName", "--output", "json"],
                  timeout=IDENTITY_TIMEOUT)
    if res.returncode != 0:
        return list(DEFAULT_REGION_SWEEP), _one_line(res)
    try:
        names = [str(r) for r in json.loads(res.stdout or "[]")]
    except (ValueError, TypeError):
        return list(DEFAULT_REGION_SWEEP), "the region list could not be parsed"
    return (sorted(names), "") if names else (list(DEFAULT_REGION_SWEEP),
                                              "the account reported no regions")


def _one_line(res) -> str:
    """The first useful line of a failed AWS call, for a report to carry."""
    text = (res.stderr or res.stdout or "").strip()
    return text.splitlines()[0].strip() if text else f"exit {res.returncode}"


def sweep_clusters(regions: list[str] | None = None, *,
                   owned_only: bool = True,
                   emit: Emit = null_emit) -> dict:
    """Every cluster in the account, region by region, and what could not be read.

    THE COMMAND THAT ANSWERS "what am I paying for". Nothing else in houston can:
    `cluster status` needs a context you already have, and `doctor` reads a local
    pointer that a fresh HOUSTON_HOME has not got -- so a cluster in a region you
    have stopped thinking about is invisible to the whole tool. That is not
    hypothetical. A cluster built by houston sat in eu-west-1 for 16.8 hours and
    $2.47 while every check run that day looked only at us-east-1, and it was found
    by an unrelated `aws` call rather than by anything here.

    The tag that identifies it has existed since the first cloud commit. What was
    missing was anything that went looking, which is the whole of this function.

    UNREADABLE IS NOT EMPTY, region by region. A region whose `list-clusters` failed
    is named in `unreadable` and contributes no clusters and no reassurance -- the one
    thing a report like this must never do is let "I could not ask fourteen regions"
    read as "you are not paying for anything".
    """
    # ONE reason, not twenty-one copies of it. Without `aws` every region fails the
    # same way, and a report whose "could not be read" list is the region list with a
    # single cause repeated buries the one sentence that matters.
    if not k8s.which(IDENTITY_TOOL):
        return {"clusters": [], "regions": [], "owned_only": owned_only,
                "fallback": "",
                "unreadable": [{"region": "(all)",
                                "why": f"{IDENTITY_TOOL} is not installed, so no "
                                       f"region could be asked"}]}
    asked, fallback_why = (regions, "") if regions else enabled_regions()
    out: dict = {
        "clusters": [], "unreadable": [], "regions": list(asked),
        "fallback": fallback_why, "owned_only": owned_only,
    }
    for i, region in enumerate(asked, 1):
        # `preflight` rather than a phase of its own: PHASES is a closed wire
        # contract and a sweep of regions is a connectivity check, which is what that
        # phase already names. Adding a vocabulary entry for one command's progress
        # would be a contract change bought for a cosmetic gain.
        info(emit, f"[{i}/{len(asked)}] {region}", phase="preflight",
             pct=int(i * 100 / max(len(asked), 1)))
        res = k8s.run([IDENTITY_TOOL, "eks", "list-clusters", "--region", region,
                       "--query", "clusters", "--output", "json"],
                      timeout=SWEEP_TIMEOUT)
        if res.returncode != 0:
            out["unreadable"].append({"region": region, "why": _one_line(res)})
            continue
        try:
            names = [str(n) for n in json.loads(res.stdout or "[]")]
        except (ValueError, TypeError):
            out["unreadable"].append({"region": region,
                                      "why": "the cluster list could not be parsed"})
            continue
        for name in names:
            seen = describe_cluster(name, region)
            if seen.state != k8s.PRESENT:
                # The cluster is THERE -- list-clusters just named it -- and could not
                # be described. Reported as unreadable rather than dropped, because a
                # cluster silently missing from this list is the exact failure the
                # function exists to prevent.
                out["unreadable"].append({
                    "region": region,
                    "why": f"{name} is there and could not be described"})
                continue
            doc = seen.doc or {}
            tags = doc.get("tags") or {}
            ours = tags.get(OWNED_TAG_KEY) == OWNED_TAG_VALUE
            if owned_only and not ours:
                continue
            out["clusters"].append({
                "name": name, "region": region, "ours": ours,
                "status": str(doc.get("status") or ""),
                "arn": str(doc.get("arn") or ""),
                "created": str(doc.get("createdAt") or ""),
                "expires": str(tags.get(EXPIRY_TAG_KEY) or ""),
            })
    return out


# --- the pointer, and it is not the authority --------------------------------------

def cluster_dir(name: str) -> Path:
    """Where everything houston knows about one cluster lives, on this box.

    A DIRECTORY rather than a single file, because the pointer is not the only thing
    worth keeping: the document eksctl was actually handed and the manifests applied
    afterwards are what answer "what is this cluster, and why is it shaped like that"
    six weeks later, when the cluster is the only evidence and nobody remembers which
    flags produced it.
    """
    return config.home() / "clusters" / name


def _pointer_path(name: str) -> Path:
    return cluster_dir(name) / "cluster.json"


def keep_manifest(name: str, filename: str, body: str) -> Path | None:
    """Write down something houston applied to a cluster. Best effort, never fatal.

    Kept on this box rather than in the cluster, and kept even when the thing it
    describes failed -- a create that died half way is exactly when somebody needs to
    read what was submitted, and a manifest that only survives success is a manifest
    that is never there when it is wanted.
    """
    try:
        path = cluster_dir(name)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        runner.atomic_write(path / filename, body)
        return path / filename
    except OSError:
        return None


def remember(name: str, *, region: str, account: str, expires: str = "") -> None:
    """Note locally that this box built a cluster. Best effort, never load-bearing.

    The TAG authorises deletion; this only lets `doctor` say "you own a cluster that
    is costing money" without an AWS round trip. Losing it costs a reminder, not
    control -- which is what makes a `mktemp -d` home survivable, and is the same
    split that makes `extra["context"]` safe: persisted for convenience, re-derivable
    when absent.
    """
    try:
        path = _pointer_path(name)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        runner.atomic_write(path, json.dumps(
            {"name": name, "region": region, "account": account,
             "provider": "eks", "expires": expires,
             "created_at": time.strftime(
                 "%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"}, indent=2))
    except OSError:
        pass


def forget(name: str) -> None:
    """Drop the local POINTER after a delete AWS confirmed, and keep the manifests.

    The pointer is what `doctor` warns from, so it has to go or the warning outlives
    the cluster. The documents do not: what was built, and how, is worth more after
    the fact than during -- somebody asking "what did we run in March" has nothing
    else to read. They are small, they are text, and nothing acts on them.
    """
    try:
        _pointer_path(name).unlink(missing_ok=True)
        # The older flat layout, for a cluster created before manifests were kept.
        (config.home() / "clusters" / f"{name}.json").unlink(missing_ok=True)
        # AND THE KUBECONFIG, which is not part of the record. The manifests stay
        # because what was built is worth reading afterwards; a kubeconfig is the
        # opposite -- it is the only file here that stops being TRUE the moment the
        # cluster goes, and the only one somebody might try to USE. Leaving it invites
        # a confusing failure against an endpoint that no longer exists.
        (cluster_dir(name) / "kubeconfig").unlink(missing_ok=True)
    except OSError:
        pass


def remembered() -> list[dict]:
    """Every cluster this box thinks it built. May be stale; never authoritative.

    Both layouts are read: `clusters/<name>/cluster.json` is where a pointer goes now,
    and `clusters/<name>.json` is where the first version put it. A box that created a
    cluster before this change must not have it vanish from `doctor`'s warning -- the
    whole point of that warning is a cluster nobody is thinking about any more.
    """
    out: list[dict] = []
    root = config.home() / "clusters"
    if not root.is_dir():
        return out
    for path in sorted([*root.glob("*/cluster.json"), *root.glob("*.json")]):
        try:
            out.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            continue
    return out


# --- creating, which spends money --------------------------------------------------

def create_cluster(name: str, *, region: str = "", nodes: int = DEFAULT_NODES,
                   subnets: dict[str, str] | None = None,
                   expires_days: int | None = DEFAULT_EXPIRY_DAYS,
                   emit: Emit = null_emit) -> dict:
    """Build an EKS cluster. Twenty minutes and real money, both on purpose.

    Never reachable from `up`. This is its own verb at its own lifecycle precisely so
    that a routine per-ticket command cannot arrive here -- `plan_cluster` adopts an
    explicitly named context and never provisions, which is what makes that structural
    rather than a matter of care.
    """
    pre = preflight()
    if not region:
        region = pre.region
    if pre.blockers:
        raise PreflightError(
            "cannot build an EKS cluster from here: " + "; ".join(pre.blockers))

    approved = config.approved_aws_accounts()
    if pre.identity.account not in approved:
        # A GATE, not a confirmation. `--force` cannot reach this and must not: force
        # is a reflex people develop, and this is a decision about somebody's bill.
        raise AuthorityGateError(
            f"building an EKS cluster in account {pre.identity.account} would cost "
            f"money, and this box has not been told it may spend in that account. "
            f"You are {pre.identity.pretty}.",
            kind="cluster", subject=f"{name} ({region})",
            approve_with=("houston config set cluster.approved_accounts "
                          + ",".join(sorted(approved | {pre.identity.account}))),
            code="GATE_CLOUD_SPEND")

    already = describe_cluster(name, region)
    if already.present:
        raise ConflictError(
            f"a cluster named {name!r} already exists in {region} "
            f"(account {pre.identity.account}). Use it with `--context`, or pick "
            f"another name.")
    if already.refused:
        raise PreflightError(
            f"could not check whether {name!r} already exists in {region}: "
            f"{k8s.why(already.res, limit=200) if already.res else 'no answer'}. "
            f"Refusing rather than risking a second cluster.")

    expires = expiry_date(expires_days)
    doc = cluster_config(name, region=region, nodes=nodes, subnets=subnets,
                         expires=expires)
    info(emit, f"building EKS cluster {name!r} in {region} — this takes 15–25 minutes "
               f"and is billable"
               + (f", and is tagged as wanted until {expires}" if expires
                  else ", with NO expiry set"), phase="provision")

    # THE NOTE GOES DOWN BEFORE THE CALL, and is only cleared once eksctl has returned.
    # A note written afterwards describes nothing: the whole case it exists for is the
    # process not getting there.
    entry = journal.record(journal.CLUSTER_UNFINISHED, name,
                           region=region, account=pre.identity.account)
    # WRITTEN BEFORE THE CALL, and eksctl is handed the kept file rather than a copy
    # in a temporary directory: the document on disk is then provably the one that was
    # submitted, and it survives a create that fails -- which is when somebody most
    # wants to read it. A temporary file deleted on the way out took the evidence with
    # it exactly when the build had gone wrong.
    kept = keep_manifest(name, "cluster.yaml", yaml.safe_dump(doc, sort_keys=False))
    if kept is None:
        with tempfile.TemporaryDirectory() as tmp:
            kept = Path(tmp) / "cluster.yaml"
            kept.write_text(yaml.safe_dump(doc, sort_keys=False))
            rc = _stream(["eksctl", "create", "cluster", "-f", str(kept)],
                         phase="provision", emit=emit, timeout=CLUSTER_CREATE_TIMEOUT)
    else:
        info(emit, f"config kept at {kept}", phase="provision")
        rc = _stream(["eksctl", "create", "cluster", "-f", str(kept)],
                     phase="provision", emit=emit, timeout=CLUSTER_CREATE_TIMEOUT)

    if rc != 0:
        # The note STAYS. eksctl may have built a VPC, a NAT gateway and a control
        # plane before failing, and houston is not going to decide on its own to
        # destroy them -- `describe()` on the note says exactly what to run.
        raise CreateFailedError(
            f"eksctl could not build {name!r} in {region} (exit {rc}); its last lines "
            f"are above. A note has been kept: `houston doctor` reports it, because "
            f"a partial create can still be billing.")

    journal.clear(entry)
    remember(name, region=region, account=pre.identity.account,
             expires=expires)
    info(emit, f"cluster {name!r} is up in {region}", phase="provision")

    context = (describe_cluster(name, region).doc or {}).get("arn", "")
    # PREPARE IS PART OF CREATE, because a cluster that cannot run a workspace is not
    # a finished answer to "create me a cluster". MEASURED: EKS ships no default
    # StorageClass, so without this the very next command refuses and the operator is
    # left patching a class by hand on a cluster they just paid twenty minutes for.
    # It stays a separate verb as well, for a cluster somebody else built.
    prepared: dict = {}
    if context:
        k8s.run(["aws", "eks", "update-kubeconfig", "--name", name,
                 "--region", region], timeout=IDENTITY_TIMEOUT)
        # AND A COPY BESIDE THE MANIFESTS. The merged kubeconfig above is the one
        # `kubectl` uses by default, and it is also the one that gets tidied, moved
        # between machines, or simply not there on somebody else's laptop -- at which
        # point the only way back to this cluster is knowing to run `aws eks
        # update-kubeconfig`, which is exactly the knowledge a person new to EKS does
        # not have. A standalone file next to the ClusterConfig and the manifests is
        # the same argument `cluster_dir` already makes: six weeks later the cluster is
        # the only evidence, and what houston wrote down is how anybody reads it.
        #
        # It holds NO credential. The file's user runs `aws eks get-token`, so it is
        # useless without the ambient AWS credentials -- which is what makes writing it
        # down safe, and is the same reason an adopted cluster works at all.
        kube_path = cluster_dir(name) / "kubeconfig"
        try:
            cluster_dir(name).mkdir(parents=True, exist_ok=True, mode=0o700)
            wrote = k8s.run(["aws", "eks", "update-kubeconfig", "--name", name,
                             "--region", region, "--kubeconfig", str(kube_path)],
                            timeout=IDENTITY_TIMEOUT)
            if wrote.returncode == 0:
                os.chmod(kube_path, 0o600)
                info(emit, f"kubeconfig kept at {kube_path} — "
                           f"`KUBECONFIG={kube_path} kubectl get nodes`",
                     phase="provision")
        except OSError:
            pass          # a kept copy is a convenience; never fail a create for it
        # AND IT BECOMES THIS BOX'S DEFAULT. houston has just built this cluster and
        # knows its ARN; making the operator read it back out of `aws` and paste it
        # into every later command is ceremony houston is imposing on itself. An ARN
        # is also the worst possible thing to ask somebody to retype.
        #
        # Announced rather than done quietly, because it changes where an un-flagged
        # `up` lands, and a default that moved without saying so is worse than one you
        # have to set.
        config.update_config(
            lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, context))
        info(emit, "set as this box's default cluster — `up` goes here without "
                   "--context now (change with `houston config set "
                   "kubernetes.context <name>`)", phase="provision")
        try:
            prepared = prepare_cluster(context, emit=emit)
        except Exception as exc:  # noqa: BLE001 - the CLUSTER exists; say so and stop
            warn(emit, f"the cluster is up but could not be prepared: {exc}. "
                       f"Run `houston cluster prepare --context {context}` once it "
                       f"is reachable — until then `up` will refuse on storage.",
                 phase="provision")
    return {"name": name, "region": region, "account": pre.identity.account,
            "nodes": nodes, "context": context, "expires": expires,
            "prepared": prepared}


# --- destroying, which is worse than creating --------------------------------------

def delete_cluster(name: str, *, region: str = "", force: bool = False,
                   emit: Emit = null_emit) -> bool:
    """Destroy an EKS cluster houston built. Returns False if there was nothing to do.

    Every guard `k8s.delete_cluster` earned through a measured incident is reproduced
    here, plus two the cloud needs. They are not defensive padding: each one is a way
    this has already gone wrong once on a local cluster, where the cost was a container
    rather than somebody else's afternoon and a VPC.
    """
    pre = preflight()
    if not region:
        region = pre.region
    if pre.blockers:
        raise PreflightError(
            "cannot delete an EKS cluster from here: " + "; ".join(pre.blockers))

    where = f"{name!r} in {region} (account {pre.identity.account})"

    # GUARD 5 and 6: the tag says ours, a refused read is NOT a yes, and the refusal
    # names the account and region -- a cluster called `support` exists in more than
    # one account and acting on the wrong one is the whole failure mode.
    mine = owns_cluster(name, region)
    if mine.refused:
        raise PreflightError(
            f"could not read the tags on {where}, so houston cannot prove it built "
            f"it — and a delete authorised by a read that failed is the one thing "
            f"that must not happen here. "
            f"{k8s.why(mine.res, limit=200) if mine.res else ''}".strip())
    if mine.absent:
        exists = cluster_exists(name, region)
        if exists.absent:
            return False
        raise AuthorityGateError(
            f"{where} was not created by houston — it carries no "
            f"{OWNED_TAG_KEY}={OWNED_TAG_VALUE} tag. houston deletes only clusters "
            f"it built; this one belongs to whoever made it.",
            kind="cluster", subject=where,
            approve_with=f"eksctl delete cluster --name {name} --region {region} --wait",
            code="GATE_DELETE_UNOWNED")

    # GUARDS 1-3: what is INSIDE it. The context an EKS kubeconfig uses is the cluster
    # ARN, which is what `aws eks update-kubeconfig` writes.
    context = str((mine.doc or {}).get("arn") or "")
    if not force:
        got = k8s.reach(context) if context else None
        if got is None or not got.ok:
            # GUARD 1. A cluster that does not answer is where houston knows LEAST
            # about what it is about to destroy -- so the refusal stands whatever the
            # cause. What changed is that it now says WHICH cause: this refusal fired
            # on an ACTIVE cluster whose only problem was that a fresh HOUSTON_HOME
            # had no kubeconfig entry for it, and "is not answering" sent the reader
            # to look at a cluster that was in perfect health.
            why = got.why() if got else ("houston has no API endpoint for it, so "
                                         "there is nothing to ask")
            raise PreflightError(
                f"what {where} is holding cannot be read: {why} — and a cluster that "
                f"cannot be read is not an empty one. Check it, or pass --force to "
                f"delete it without looking."
                + (got.advice(context) if got else ""))
        holding = k8s.workspace_namespaces(context)
        if holding is None:
            # GUARD 2. An unreadable list is not an empty one.
            raise PreflightError(
                f"the workspace list in {where} could not be read, which is not the "
                f"same as it being empty. Refusing.")
        if holding:
            # GUARD 3, and on a shared cloud cluster it changes character: the owners
            # may be colleagues on OTHER boxes whose HOUSTON_HOME this machine has
            # never seen, so this refusal is the only record that they exist.
            owners = sorted({k8s.namespace_owner(ns, context=context) or "unknown"
                             for ns in holding})
            raise ConflictError(
                f"{where} still holds {len(holding)} workspace(s), owned by "
                f"{', '.join(owners)}. Deleting the cluster takes them with it, and on "
                f"a shared cluster their owners are not necessarily on this machine. "
                f"Remove them first, or pass --force.")
    else:
        warn(emit, f"--force: deleting {where} without reading what it holds",
             phase="teardown")

    info(emit, f"deleting {where} — this takes 10–20 minutes", phase="teardown")
    # `--wait` is NOT optional. Without it eksctl returns as soon as the stack delete
    # is accepted, and the caller gets a success for a teardown that may still fail
    # halfway and leave the expensive parts behind.
    rc = _stream(["eksctl", "delete", "cluster", "--name", name,
                  "--region", region, "--wait"],
                 phase="teardown", emit=emit, timeout=CLUSTER_DELETE_TIMEOUT)
    if rc != 0:
        raise DockerError(
            f"eksctl could not delete {where} (exit {rc}); its last lines are above. "
            f"If it says the cluster does not exist, its CloudFormation stack may have "
            f"survived a rollback — check `aws cloudformation describe-stacks "
            f"--stack-name eksctl-{name}-cluster --region {region}`.")
    forget(name)
    # AND THE KUBECONFIG ENTRY GOES WITH IT. Two tools wrote one -- `eksctl` and `aws
    # eks update-kubeconfig` -- and neither removes it, so a deleted cluster kept
    # appearing on the ledger for ever. Filtering it out of every report afterwards
    # works and costs a probe and an AWS call on every single list, which is how a
    # "cheap" list became two seconds. Removing it once, here, is where it belongs:
    # houston wrote the entry and is deleting the cluster.
    #
    # Only houston's OWN kubeconfig. The user's is theirs.
    # Both spellings, whatever they are called: the ARN this cluster answered to, and
    # eksctl's `<iam-user>@<cluster>.<region>.eksctl.io`, whose user part varies.
    suffix = f"@{name}.{region}.eksctl.io"
    known, _unreadable = k8s.contexts()
    for alias in {c for c in known
                  if c.endswith(suffix) or c.endswith(f":cluster/{name}")}:
        k8s.forget_context(alias)
    # AND THE DEFAULT GOES WITH IT. A `kubernetes.context` pointing at a cluster that
    # no longer exists makes the next `up` fail on a context that cannot be found,
    # which reads as a bug in `up` rather than as the consequence of a delete.
    if config.default_kube_context() == context:
        config.update_config(lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, ""))
        info(emit, "cleared this box's default cluster — it was the one just deleted",
             phase="teardown")
    return True


# --- making a created cluster able to serve --------------------------------------

#: The StorageClass a fresh EKS cluster does NOT have, and the reason `cluster create`
#: on its own hands back something that cannot run a workspace.
#:
#: MEASURED on EKS 1.33: the cluster ships exactly one class, `gp2`, on the IN-TREE
#: provisioner `kubernetes.io/aws-ebs` -- deprecated, and not the driver the
#: `aws-ebs-csi-driver` addon installs. Nothing references `ebs.csi.aws.com`, so the
#: addon we pin at Launchpad's version sits there doing nothing, and no class is marked
#: default, so every PVC would stay Pending and Rocket.Chat would never start.
#:
#: `WaitForFirstConsumer` because the volume must be created in the availability zone
#: the pod lands in. Binding immediately puts an EBS volume in one zone and then lets
#: the scheduler put the pod in another, which fails in a way that reads as a
#: scheduling problem rather than a storage one.
STORAGE_CLASS_NAME = "gp3"
STORAGE_CLASS = f"""apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: {STORAGE_CLASS_NAME}
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
"""


def prepare_cluster(context: str, *, emit: Emit = null_emit) -> dict:
    """Make a cluster able to serve a workspace over HTTPS. Idempotent.

    Separate from `create_cluster` as a VERB but run by it, because the two answer
    different questions and only one of them costs money. `create` builds
    infrastructure; `prepare` configures it, is free, and is safe to run again on a
    cluster somebody else built or on one whose ingress was removed.

    Three things, and houston already had two of them -- `ensure_ingress` and
    `ensure_cert_manager` both adopt what a cluster has before installing anything,
    which matters more here than it looks: the ingress controller is usually the
    component a support case is ABOUT, so a cluster already running nginx must keep
    running nginx.

    Returns what a human still has to do. The DNS record is the honest boundary of
    this tool: the ingress gets a load balancer hostname, and something has to point
    the workspace's name at it before Let's Encrypt will validate. Launchpad has the
    same boundary and solves it the same way -- it prints the name and waits.
    """
    # THE SHORT NAME, RESOLVED -- like `cluster status` already does. `--context
    # support` is the form `cluster create` prints in its own closing line and the
    # form the guide teaches, and an EKS context is really
    # `arn:aws:eks:<region>:<account>:cluster/support`, which nobody types. Passing
    # the short name straight to kubectl made every read refuse, and the refusal it
    # produced was "could not read the StorageClasses ... This is a permissions
    # problem on the credential in your kubeconfig" -- a confident, wrong diagnosis
    # that sends somebody to fix IAM when the context simply had not been expanded.
    # MEASURED on a freshly created cluster: `cluster prepare --context support`
    # failed in 0.27s, which is far too fast to have asked AWS anything.
    context, _unreadable = k8s.assert_context_known(context)
    out: dict = {"context": context, "storage_class": "", "ingress_class": "",
                 "cert_manager": False, "cname_target": "", "cname_pending": False,
                 "already": [], "kept": ""}

    seen = k8s.storage_classes(context)
    if seen is None:
        raise PreflightError(
            f"could not read the StorageClasses in {context!r}, so houston cannot "
            f"tell whether a volume would bind. This is a permissions problem on the "
            f"credential in your kubeconfig, not a missing provisioner.")
    names, default = seen
    if default:
        # ADOPT. A cluster that already has a default has been set up by somebody, and
        # replacing their choice is not this command's business -- `up` only needs ONE
        # to exist, and a second default is an error state in Kubernetes anyway.
        out["storage_class"] = default
        out["already"].append(f"storage class {default!r}")
    else:
        info(emit, f"installing the {STORAGE_CLASS_NAME!r} storage class — EKS ships "
                   f"only {', '.join(names) or 'none'}, and none of them default",
             phase="provision")
        k8s.apply(STORAGE_CLASS, namespace="default", context=context)
        out["storage_class"] = STORAGE_CLASS_NAME
        # Kept beside the ClusterConfig. `prepare` runs against a context, which may
        # name a cluster houston did not build and therefore has no directory for --
        # the ARN's last segment is that cluster's name, and is what a person would
        # look under.
        out["kept"] = str(keep_manifest(context.rsplit("/", 1)[-1],
                                        "storageclass.yaml", STORAGE_CLASS) or "")

    out["ingress_class"] = k8s.ensure_ingress(context=context, distribution="eks",
                                              invited=True, emit=emit)
    k8s.ensure_cert_manager(context=context, distribution="eks",
                            invited=True, emit=emit)
    out["cert_manager"] = True

    # The address a CNAME has to point at. Read rather than assumed, and empty is a
    # real answer -- reporting a blank as though it were a hostname would send somebody
    # to make a broken record.
    #
    # WAITED FOR, because this runs immediately after a twenty-minute `cluster create`
    # and an ELB commonly takes one to three minutes to publish a hostname. Asking once
    # made a blank CNAME target the NORMAL outcome of a successful create -- on the one
    # line an operator needs in order to finish the job. The wait returns the moment
    # nothing is pending, so a cluster with no LoadBalancer Service at all costs one
    # read rather than three minutes.
    _, address = k8s.wait_for_loadbalancer(context, emit=emit)
    out["cname_target"] = address
    # WHICH KIND OF BLANK, so the CLI can say. "No ingress controller published one"
    # and "it was still coming when we stopped waiting" need different next actions:
    # the first is a cluster that was never prepared, the second is `prepare` again in
    # a minute.
    out["cname_pending"] = bool(not address and k8s.loadbalancer_state(context)[2])
    # EMITTED, not merely returned. This is the one line an operator has to act on --
    # the whole point of running `prepare` -- and it lived only in the returned
    # document, so the CLI printed it and the GUI did not: the job's log field showed
    # "ingress: adopting traefik / cert-manager: already in this cluster / done" and
    # never the address, which is the opposite of useful. A fact that reaches only the
    # return value is invisible in the GUI, the mirror of this project's rule about
    # printing instead of emitting.
    if address:
        info(emit, f"point your name at: {address}", phase="tls")
    elif out["cname_pending"]:
        warn(emit, "the load balancer still has no address — it can take a few "
                   "minutes. Run prepare again to read it, then make the DNS record.",
             phase="tls")
    else:
        warn(emit, "no LoadBalancer Service is waiting for an address, so nothing is "
                   "going to publish one. This cluster has no load-balancing ingress "
                   "— workspaces here reach you by port-forward, and `--domain` needs "
                   "one.", phase="tls")
    return out
