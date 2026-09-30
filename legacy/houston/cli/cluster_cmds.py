"""The cloud cluster: `cluster status|list|guide|create|prepare|delete|forget|iam-policy`.

One command with a positional action rather than eight, because these are eight views of
one object and `houston cluster` with no argument should answer "what have I got".

**This is the expensive verb.** `cluster create` costs money and takes about twenty
minutes; `up` is per ticket and free. `up` can never provision a cloud cluster, and that
is structural rather than a matter of care -- the two live at different lifetimes and the
registry `create_repro` enforces has no path to `eksctl`.
"""
from __future__ import annotations

import textwrap

import typer

from houston import config, errors, jsonout, ui
from houston.cli._common import (_cli_emit,
                                 _fail)


CLUSTER_ACTIONS = ("status", "list", "guide", "iam-policy",
                   "create", "prepare", "delete", "forget")


def _cluster_iam_policy(json_out, name):
    """`cluster iam-policy`: the document an administrator has to approve."""
    from houston.services import eks as ekssvc
    if json_out:
        jsonout.reply("cluster-iam-policy", {
            "documents": [
                {"name": key, "filename": ekssvc.IAM_DOCUMENTS[key][0],
                 "purpose": ekssvc.IAM_DOCUMENTS[key][1],
                 "body": ekssvc.iam_document(key)}
                for key in (sorted(ekssvc.IAM_DOCUMENTS) if not name else [name])
            ]})
        return
    if not name:
        # THE MENU, only when no document was asked for. With one named, stdout
        # carries the document and NOTHING else, because the next thing that
        # happens to it is `> operator.json` or a pipe into `kubectl apply -f -`,
        # and a helpful header is a syntax error in somebody's terminal.
        ui.note("permissions documents houston ships, each verified by using it:")
        for key in sorted(ekssvc.IAM_DOCUMENTS):
            fname, purpose = ekssvc.IAM_DOCUMENTS[key]
            ui.note(f"  {key:<9} {fname}")
            for line in textwrap.wrap(purpose, 74):
                ui.note(f"            {line}")
        ui.note("")
        ui.note("  houston cluster iam-policy operator > operator-policy.json")
        ui.note("  aws iam create-policy --policy-name houston-cluster-operator \\")
        ui.note("      --policy-document file://operator-policy.json")
        ui.note("  houston cluster iam-policy rbac | kubectl apply -f -")
        return
    try:
        typer.echo(ekssvc.iam_document(name).rstrip("\n"))
    except errors.ReproError as exc:
        _fail(exc)
    return


def _cluster_guide(json_out, path_only):
    """`cluster guide`: the walk-through for somebody who has never made one."""
    from houston.services import eks as ekssvc
    if path_only:
        found = ekssvc.guide_path()
        if json_out:
            jsonout.reply("cluster-guide", {"path": str(found or "")})
        else:
            typer.echo(str(found) if found else "")
        return
    try:
        body = ekssvc.guide()
    except errors.ReproError as exc:
        _fail(exc)
    if json_out:
        jsonout.reply("cluster-guide", {"path": str(ekssvc.guide_path() or ""),
                                        "body": body})
        return
    # STDOUT CARRIES THE DOCUMENT AND NOTHING ELSE, like `iam-policy`: the next
    # thing that happens to it is a pipe into a pager or a file.
    typer.echo(body.rstrip("\n"))
    return


def _cluster_status_json(report, unusable):
    """`cluster status` as a machine document."""
    for missing in report["unreadable"]:
        jsonout.warn_once(f"CLUSTER_UNREADABLE_{missing.upper()}",
                          f"{missing} could not be read; it is reported as "
                          f"unknown rather than as none")
    if unusable:
        # A SUCCESS ENVELOPE FOLLOWED BY A NON-ZERO EXIT is the one thing the
        # contract cannot survive: `ok` is the field a caller is told to read, and
        # it said true while the process exited 3. Where kubectl exists this path
        # is never reached -- `status()` refuses an unknown context with a typed
        # error -- so the disagreement only appeared on a machine without it,
        # which is every CI runner and no developer's box.
        _fail(errors.PreflightError(
            f"cluster {report['context'] or '(none)'} is not usable from here: "
            + ("no context is configured" if not report["context"]
               else "it is not reachable")))
    jsonout.reply("cluster", report)
    return


def _cluster_prepare(context, json_out):
    """`cluster prepare`: make an existing cluster able to serve a workspace."""
    # By CONTEXT, not by name: prepare is kubectl work on a cluster that already
    # exists, and the thing it needs is the way in rather than the way it was made.
    # That also lets it run on a cluster houston did not build.
    from houston.services import eks as ekssvc
    ctx = context or config.default_kube_context()
    if not ctx:
        _fail(errors.ValidationError(
            "`cluster prepare` needs --context <name>, or a default from "
            "`houston config set kubernetes.context <name>`."))
    try:
        out = ekssvc.aws.prepare_cluster(ctx, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    if json_out:
        jsonout.reply("cluster-prepare", out)
        return
    ui.ok(f"{ctx} is ready to serve a workspace")
    ui.note(f"  storage   {out['storage_class']}")
    ui.note(f"  ingress   {out['ingress_class']}")
    ui.note("  certs     cert-manager installed")
    if out["already"]:
        ui.note(f"  adopted   {', '.join(out['already'])} — left as they were")
    # THE ADDRESS ITSELF IS EMITTED by the service, so both front-ends show it in
    # the same place and it is not said twice here. What stays is the next command,
    # which only makes sense in a terminal.
    if out["cname_target"]:
        ui.note("  then: houston up --version 8.5.1 --name t1 --runtime kubernetes "
                f"--context {ctx} --domain <your name>")
    return


def _cluster_list(force, json_out, region):
    """`cluster list`: every cluster this box could talk to."""
    # THE ONLY COMMAND THAT LOOKS WHERE YOU ARE NOT ALREADY LOOKING. Every other
    # reader here needs a context or a local pointer, so a cluster in a region
    # nobody is thinking about is invisible to all of them — which is how one sat
    # billing for 16.8 hours while that day's checks swept a single region.
    from houston.services import eks as ekssvc
    found = ekssvc.sweep_clusters([region] if region else None,
                                  owned_only=not force, emit=_cli_emit)
    if json_out:
        for bad in found["unreadable"]:
            jsonout.warn_once(
                f"REGION_UNREADABLE_{bad['region'].upper().replace('-', '_')}",
                f"{bad['region']} could not be read ({bad['why']}); it is reported "
                f"as unknown rather than as holding nothing")
        jsonout.reply("cluster-list", found)
        return
    rows = found["clusters"]
    if rows:
        ui.warn(f"{len(rows)} cluster(s) — every one of these is billing")
        for row in rows:
            mark = "houston" if row["ours"] else "not houston's"
            when = (row["created"] or "")[:10]
            due = f" · expires {row['expires']}" if row["expires"] else ""
            ui.note(f"  {row['region']:<15} {row['name']:<24} "
                    f"{row['status'] or '?':<9} {mark}  created {when or '?'}{due}")
        ui.note("  `houston cluster status --context <name>` prices one of them "
                "— the cluster's own name is enough.")
    elif found["regions"]:
        ui.ok(f"no {'houston ' if not force else ''}clusters found in "
              f"{len(found['regions'])} region(s)")
    # NO REASSURING LINE WHEN NOTHING WAS SWEPT. "no clusters found in 0 regions"
    # is the sentence this whole command exists to stop being printed: it reads as
    # "you are paying for nothing" and means "I did not look anywhere".
    # SAID LAST AND SAID PLAINLY. "Nothing found" and "nothing found in the
    # fourteen regions I could read" are different reports, and only the second
    # one is honest when a sweep was partly refused.
    if found["unreadable"]:
        ui.warn(f"{len(found['unreadable'])} region(s) could NOT be read — this "
                f"report does not cover them:")
        for bad in found["unreadable"]:
            ui.note(f"  {bad['region']:<15} {bad['why']}")
    if found["fallback"]:
        ui.note(f"swept a built-in region list because the account could not be "
                f"asked which are enabled ({found['fallback']})")
    return


def _cluster_forget(context, force, json_out, name):
    """`cluster forget`: drop the local record without touching the cluster."""
    # THE KUBECONFIG ENTRY, NEVER THE CLUSTER. `delete` takes the cluster away and
    # tidies the entries it wrote; this is for the entry left behind when the
    # cluster went away some OTHER way -- deleted from the console, by a colleague,
    # or by an eksctl run that predates houston. Those entries are unreachable for
    # ever and read on a card as "not answering", which is the alarming way to say
    # "nothing is there".
    #
    # It refuses a cluster that answers, because at that point the name is a
    # working cluster and forgetting it would be taking away access to something
    # live rather than clearing litter. `--force` is the override.
    from houston.services import k8s
    target = (name or context or "").strip()
    if not target:
        _fail(errors.ValidationError(
            "which context should be forgotten? `houston cluster forget "
            "<context>`, or `houston cluster list` to see what is there."))
    # A DANGLING `current-context` IS THE LITTER, and it is the one shape of it
    # that `assert_context_known` refuses -- the entry has already been removed and
    # only the pointer at it is left, so the name is not in `contexts()` and the
    # refusal reads "no kubeconfig context named ...", which is true and useless.
    # That is exactly the state a delete used to leave behind, so the command that
    # exists to clear it has to accept it.
    if target == k8s.active_context():
        known = target
    else:
        known, _unreadable = k8s.assert_context_known(target)
    if not force and k8s.reach(known).ok:
        _fail(errors.ConflictError(
            f"{known!r} is answering, so it is a cluster you can still use rather "
            f"than a leftover entry. `houston cluster delete` takes a cluster "
            f"away; `--force` forgets a working one anyway."))
    gone = k8s.forget_context(known)
    if not gone:
        # SAID, NOT SWALLOWED. `kubectl config unset` succeeds whether or not there
        # was anything to unset, so "it worked" is not evidence the entry is gone.
        # And said in BOTH modes: `--json` replied ok with `forgotten: false` and exit 0
        # ahead of this, where a human got CONFLICT and exit 8 for the same entry.
        _fail(errors.ConflictError(
            f"{known} is still named by a kubeconfig — remove it by hand with "
            f"`kubectl config delete-context {known}`"))
    if json_out:
        jsonout.reply("cluster-forget", {"context": known, "forgotten": gone})
        return
    ui.ok(f"forgot {known} — the cluster itself was not touched")
    return


def _cluster_delete(ekssvc, force, json_out, name, region, yes):
    """`cluster delete`: destroy the cluster, its nodes and its volumes."""
    # READ BEFORE ASKING. The prompt used to be the first thing that
    # happened, so `houston cluster delete default` -- a LOCAL k3s context,
    # not an EKS cluster -- asked "Delete EKS cluster 'default'? This destroys
    # the cluster, its nodes and its volumes", and only refused afterwards.
    # Asking somebody to consent to destroying something that is not there is
    # how people learn to type `y` at a prompt that means nothing, and this
    # file already holds the rule elsewhere: every read-only refusal comes
    # first.
    #
    # ONLY A DEFINITE ABSENCE short-circuits. REFUSED is "I could not ask" --
    # and the six guards inside `delete_cluster` are the real gate either way,
    # so an unreadable answer still goes through the prompt and into them.
    from houston.services import k8s as k8smod
    seen = ekssvc.aws.describe_cluster(name, region or ekssvc.aws.preflight().region)
    if seen.state == k8smod.ABSENT:
        if json_out:
            jsonout.reply("cluster-delete", {"name": name, "deleted": False})
            return
        ui.note(f"no EKS cluster named {name!r}"
                + (f" in {region}" if region else "")
                + " — nothing to delete."
                + (" That name is a kubeconfig context on this machine; "
                   f"`houston cluster forget {name}` clears the entry, and "
                   "only a cluster houston built in AWS can be deleted here."
                   if name in (k8smod.contexts()[0] or []) else ""))
        return

    # delete. The prompt is not the gate -- the TAG is -- but a 15-minute
    # destructive operation on somebody's AWS account still asks.
    if not yes and not jsonout.active():
        typer.confirm(
            f"Delete EKS cluster {name!r}"
            + (f" in {region}" if region else "")
            + "? This destroys the cluster, its nodes and its volumes.",
            abort=True)
    gone = ekssvc.aws.delete_cluster(name, region=region, force=force,
                                 emit=_cli_emit)
    if json_out:
        jsonout.reply("cluster-delete", {"name": name, "deleted": gone})
        return
    if gone:
        ui.ok(f"cluster {name!r} is gone")
    else:
        ui.note(f"no cluster named {name!r} to delete")
    return


def _cluster_create_or_delete(action, expires, force, json_out, name, nodes, region, subnet, yes):
    """`cluster create|delete`: the two verbs that cost money and take twenty minutes."""
    from houston.services import eks as ekssvc
    if not name:
        _fail(errors.ValidationError(
            f"`cluster {action}` needs the cluster's name, e.g. "
            f"`houston cluster {action} support`."))
    try:
        if action == "create":
            pairs: dict[str, str] = {}
            for item in (subnet or []):
                if "=" not in item:
                    _fail(errors.ValidationError(
                        f"--subnet wants `<az>=<subnet-id>`, got {item!r}"))
                az, sid = item.split("=", 1)
                pairs[az.strip()] = sid.strip()
            want = (expires or "").strip().lower()
            if want in ("never", "none", "0"):
                days: int | None = None
            elif not want:
                days = ekssvc.DEFAULT_EXPIRY_DAYS
            else:
                try:
                    days = int(want)
                except ValueError:
                    _fail(errors.ValidationError(
                        f"--expires wants a number of days or `never`, "
                        f"got {expires!r}"))
            out = ekssvc.aws.create_cluster(
                name, region=region, nodes=nodes or ekssvc.DEFAULT_NODES,
                subnets=pairs or None, expires_days=days, emit=_cli_emit)
            if json_out:
                jsonout.reply("cluster-create", out)
                return
            ui.ok(f"cluster {name!r} is up in {out['region']}")
            if out.get("expires"):
                ui.note(f"  tagged as wanted until {out['expires']} — "
                        f"`houston doctor` says so once that passes")
            else:
                ui.warn("  no expiry set — nothing will remind you this is running")
            # THE LINE PEOPLE COPY. It printed the full ARN and `--runtime
            # kubernetes` beside a `--context` that already implies Kubernetes, so
            # the command it taught was the two most awkward forms of itself.
            ui.note(f"  point a workspace at it: houston up --version 8.5.1 "
                    f"--name TICKET-1234 --context {name} --domain <your name>")
            return

        return _cluster_delete(ekssvc, force, json_out, name, region, yes)
    except errors.ReproError as exc:
        _fail(exc)


def _render_cluster_cost(report):
    """The shared installs, the bill, and anything that could not be read."""
    if report.get("manageable") is False and report.get("unmanageable_why"):
        ui.warn(f"stuck     {report['unmanageable_why']}")
    shared = [n for n, on in (("operator", report["operator"]),
                              ("monitoring", report["monitoring"])) if on]
    ui.note(f"shared    {', '.join(shared) if shared else 'none installed'}")

    cost = report["cost"]
    if cost:
        ui.warn(f"cost      ~${cost['usd_hr']}/hr  (~${round(cost['usd_hr'] * 24, 2)}/day)"
                f"  ESTIMATE — {cost['basis']}")
        if cost["unpriced"]:
            ui.warn("          plus " + ", ".join(
                f"{n}x {t or 'unlabelled'}" for t, n in cost["unpriced"].items())
                + " which this build cannot price — the figure above is LOW")
        if cost.get("incomplete"):
            # A read that FAILED, not a gap in the price table. Said differently
            # because only one of them is fixed by adding a row to a dict.
            ui.warn("          and " + ", ".join(cost["incomplete"])
                    + " could not be counted — the figure above is INCOMPLETE, not"
                      " merely approximate")
    for missing in report["unreadable"]:
        ui.warn(f"unread    {missing}")


def _render_cluster_shape(q, report):
    """What the cluster is, how old, and what is running on it."""
    owned = "houston's own" if report["ours"] else "yours"
    ui.ok(f"{report['distribution'] or 'unknown'} · {owned} · "
          f"{q(report['nodes'])} node(s)")
    if report["age_hours"] is not None:
        days, hours = divmod(int(report["age_hours"]), 24)
        ui.note(f"up for    {days}d {hours}h")
    if report["instance_types"]:
        shape = ", ".join(f"{n}x {t or 'unlabelled'}"
                          for t, n in sorted(report["instance_types"].items()))
        ui.note(f"nodes     {shape}")

    rows = report["workspaces"]
    if rows is None:
        ui.warn("workspaces could not be listed — not the same as none")
    else:
        ui.note(f"holding   {len(rows)} workspace(s), {q(report['pvcs'])} volume(s)")
        for row in rows:
            who = row["owner"] if row["owner_readable"] else "owner unreadable"
            ui.note(f"            {row['name']}  ({who or 'unowned'}, "
                    f"{row['pvcs']} volume(s))")
    ui.note(f"services  {q(report['loadbalancers'])} LoadBalancer(s)"
            + ("   — each one is billed on a managed cluster"
               if report["cost"] else ""))


def _cluster_status(clustersvc, context, json_out):
    """`cluster status`: one read-only pass over everything a cluster is holding."""
    # WRAPPED, like the other 26 service calls in this file. `status()` refuses an
    # unknown context with a ValidationError, and an unwrapped raise leaves `--json`
    # with an empty stdout and a non-zero exit -- the exact break
    # `test_every_json_command_answers_with_exactly_one_envelope` exists to catch, and
    # it caught it here.
    try:
        report = clustersvc.status(context=context)
    except errors.ReproError as exc:
        _fail(exc)
    # ONE verdict for both front ends. `doctor` sets the precedent and the reason is
    # the same: a command that exits 1 for a human and 0 for `--json` is one command
    # answering two ways, and the caller most likely to be scripting it is the one
    # least able to notice. PreflightError's code rather than a bare 1, because "that
    # cluster is not answering" is a different fact from "houston broke".
    unusable = not report["context"] or not report["reachable"]

    if json_out:
        return _cluster_status_json(report, unusable)

    def q(value, suffix: str = "") -> str:
        """`?` for anything that could not be read. Never a zero."""
        return "?" if value is None else f"{value}{suffix}"

    ui.note(f"cluster   {report['context'] or '(none)'}")
    if not report["context"]:
        ui.fail("No cluster configured. `houston config set kubernetes.context <name>`, "
                "or point kubectl at one.")
        raise typer.Exit(errors.PreflightError.exit_code)
    if not report["reachable"]:
        # WHICH KIND OF UNREACHABLE. "is not answering" was printed for a cluster that
        # was ACTIVE and answering and merely refusing the caller's credential, which
        # sent the reader to check the one thing that was fine. The two sentences after
        # it stay: whatever the cause, the counts below are unknown rather than zero.
        ui.fail(f"{report['context']!r} cannot be read: "
                f"{report['reach_why'] or 'it is not answering'}. Nothing below could "
                f"be read — this is NOT a report that the cluster is empty.")
        if report["reach_advice"]:
            ui.note(report["reach_advice"].strip())
        raise typer.Exit(errors.PreflightError.exit_code)

    _render_cluster_shape(q, report)
    _render_cluster_cost(report)


def _dispatch_cluster(action, context, expires, force, json_out, name, nodes, path_only, region, subnet, yes):
    """Which `cluster` verb was asked for. The command itself is its options and its help."""
    from houston.services import cluster as clustersvc

    # ACTIVATED BEFORE THE FIRST REFUSAL, so `cluster bogus --json` answers with the
    # VALIDATION_FAILED envelope the contract promises. The action was checked first, and
    # a caller reading the last line of stdout got an empty stream and exit 2.
    if json_out:
        jsonout.activate()
    if action not in CLUSTER_ACTIONS:
        _fail(errors.ValidationError(
            f"unknown action {action!r}. Want: " + " | ".join(CLUSTER_ACTIONS) + "."))

    if action == "guide":
        return _cluster_guide(json_out, path_only)

    if action == "iam-policy":
        return _cluster_iam_policy(json_out, name)

    if action == "forget":
        return _cluster_forget(context, force, json_out, name)

    if action == "list":
        return _cluster_list(force, json_out, region)

    if action == "prepare":
        return _cluster_prepare(context, json_out)

    if action in ("create", "delete"):
        return _cluster_create_or_delete(action, expires, force, json_out, name, nodes, region, subnet, yes)
    return _cluster_status(clustersvc, context, json_out)


def cluster_cmd(
    action: str = typer.Argument("status", help="status | list | guide | iam-policy | create | prepare | delete | forget"),  # noqa: E501 - mirrors CLUSTER_ACTIONS
    name: str = typer.Argument("", help="the cluster's name, for `create` and `delete`; which document, for `iam-policy`"),
    context: str = typer.Option("", "--context", help="which cluster — its own name (`support`) or the full context name (status). Defaults to `kubernetes.context`, then to the one `up` would use"),
    region: str = typer.Option("", "--region", help="AWS region (create/delete; narrows `list` to one region). Defaults to the one `aws` resolves"),
    nodes: int = typer.Option(0, "--nodes", help="how many nodes (create). Default 3; Launchpad sizes 5 for a production workspace"),
    expires: str = typer.Option("", "--expires", help="days until you expect to be finished with this cluster, or `never` (create). Default 7. A REMINDER only — nothing deletes on it"),
    subnet: list[str] = typer.Option(None, "--subnet", help="use an EXISTING VPC: `--subnet <az>=<subnet-id>`, repeatable. Without any, a new VPC is created"),
    force: bool = typer.Option(False, "--force", help="delete without reading what the cluster holds; on `list`, show every cluster and not only houston's"),
    yes: bool = typer.Option(False, "--yes", "-y", help="skip the confirmation prompt (delete)"),
    path_only: bool = typer.Option(False, "--path", help="print where the shipped guide is on this machine, and nothing else (guide)"),
    json_out: bool = typer.Option(False, "--json", help="print the ledger as one JSON envelope"),
) -> None:
    """What a Kubernetes cluster is holding, and what it is costing.

    NEW TO THIS? `houston cluster guide` prints the whole EKS walkthrough — what to
    install, which permissions to grant, and the six commands from an empty AWS
    account to a workspace on a real domain and back to nothing.

    A peer of `edge`: the cluster is not a workspace, so it never appears in `list`
    and `prune`/`down` cannot describe it — but something holding your workspaces,
    your volumes and, on a managed cluster, your money should be answerable, and
    this is where it answers.

    `status` is read-only and free on every distribution — kind, an adopted k3s or a
    managed one. `create` and `delete` are neither, and they are deliberately their
    own verb: `up` can never build a cloud cluster, at any lifecycle, under any flag,
    because it is the command you run per ticket and this one takes twenty minutes and
    real money.

    `create` makes a NEW VPC unless `--subnet <az>=<id>` names an existing one, and it
    is gated on the AWS account having been approved on this box. `delete` removes only
    a cluster houston built, proved by a tag on the cluster itself rather than by its
    name.

    Nothing here reports a zero it did not read. A cluster that cannot be reached
    shows `?` rather than "0 workspaces, nothing running" — a ledger whose job is to
    stop a cluster being forgotten must not be the thing that says it is empty.
    """
    return _dispatch_cluster(action, context, expires, force, json_out, name, nodes, path_only, region, subnet, yes)
