# Rocket.Chat on Amazon EKS

This guide takes you from an empty AWS account to a Rocket.Chat workspace on your own
domain with a real certificate, and then back to nothing billing. It is written for
someone who has never used EKS. Do the steps in order.

The guide ships with houston: `houston cluster guide` prints it, and
`houston cluster guide --path` prints where the file is.

Two words come up throughout:

* A **cluster** is a group of AWS machines that run containers. EKS is Amazon's managed
  Kubernetes. A cluster bills by the hour from the moment it exists until it is deleted.
* A **workspace** is one Rocket.Chat. One cluster holds many workspaces, each in its own
  Kubernetes namespace.

| Command | Takes | Costs | How often |
|---|---|---|---|
| `houston cluster create` | 15 to 25 minutes | the cluster's hourly rate, until you delete it | once per team |
| `houston up --context support` | a few minutes | one 8 GB disk per workspace, on top of the cluster | once per ticket |

`houston up` never creates a cloud cluster, whatever flags you give it. Only
`houston cluster create` does.

---

## 1 · Quick path

The whole procedure in one block, for when you have done it before. Every step is
explained in the sections that follow.

This block assumes the tools are installed (section 3) and the one-time AWS setup is
done (section 4). Replace `rc.example.com` with a DNS zone you control and
`you@example.com` with your own address.

```bash
# Check this machine. You want the line "AWS ready — …".
houston doctor

# Approve this AWS account for spending, and give Let's Encrypt a contact address.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
houston config set cluster.approved_accounts "$ACCOUNT_ID"
houston config set acme.email you@example.com

# Build the cluster: 15 to 25 minutes, billing from now. Copy the "point your name at:" address.
houston cluster create support --region us-east-1

# In your DNS provider add  *.rc.example.com  CNAME  <that address>, then check it.
dig +short t1234.rc.example.com CNAME @1.1.1.1

# One workspace per ticket, on its own public HTTPS name.
houston up --version 8.5.1 --name TICKET-1234 --context support --domain t1234.rc.example.com --wait

# Its URL and its generated admin password.
houston info --name TICKET-1234

# Done with the ticket: remove the workspace and its disk.
houston down --name TICKET-1234 --volumes --yes

# Done with the cluster: release its load balancer, then delete it in the same region.
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl delete svc -A --field-selector spec.type=LoadBalancer
houston cluster delete support --region us-east-1 --yes

# Confirm nothing is left.
houston cluster list
```

---

## 2 · What it costs, and how to stop the bill

The cluster bills every hour it exists, whether or not anything runs in it. The rates
below are the ones houston itself uses (us-east-1, on demand), so they match what
`houston cluster status` prints. A plain `houston cluster create` builds **3 nodes**.

| Part | Rate | 3 nodes (default) | `--nodes 2` | `--nodes 5` |
|---|---|---|---|---|
| EKS control plane | $0.10/hour | $0.1000 | $0.1000 | $0.1000 |
| NAT gateway | $0.045/hour | $0.0450 | $0.0450 | $0.0450 |
| Nodes, `t3.large` | $0.0832/hour each | $0.2496 | $0.1664 | $0.4160 |
| Node disks, 80 GB gp3 each | $0.08 per GB-month | $0.0263 | $0.0175 | $0.0438 |
| Load balancer (the ingress) | $0.0225/hour | $0.0225 | $0.0225 | $0.0225 |
| **Per hour** | | **$0.4434** | **$0.3514** | **$0.6273** |
| **Per day** | | **$10.64** | **$8.43** | **$15.06** |
| **Per month (730 hours)** | | **about $324** | **about $257** | **about $458** |

Each workspace adds one 8 GB gp3 disk for its database: about $0.64 a month. That is
small, but a disk left behind after the cluster is gone keeps billing (section 9).

The figures leave out data transfer and public IP address charges, and other regions
price differently, so the real bill is a little higher.

**These do not stop the bill:**

* Removing workspaces with `houston down`. The cluster's rate stays the same.
* Leaving the cluster idle, or shutting down your own machine.
* The expiry date. `--expires` (default 7 days, `never` for none) only writes a
  reminder tag on the cluster. Nothing deletes on it. `houston doctor` on the machine
  that built the cluster warns that it is billing and counts the days to that date, and
  `houston cluster list` shows the date.

**This stops it:** `houston cluster delete support --region us-east-1`, followed by the
leftover check in section 9.

**To see what is billing:**

```bash
houston cluster status --context support   # one cluster: nodes, workspaces, load balancers, cost per hour and day
houston cluster list                       # every houston-built cluster, in every region the account has enabled
houston cluster list --force               # the same, plus clusters built without houston
```

`cluster status` never reports a zero it could not read. If the cluster does not
answer, it says so, and anything it could not count shows as `?`.

`cluster list` ends with any region it could not read. Those regions are not covered
by the report, so check them another way (`aws eks list-clusters --region <region>`).

---

## 3 · Before you start

You need:

* An AWS account, and someone with IAM administrator rights for the one-time setup in
  section 4.
* A DNS zone you can edit, such as `rc.example.com`. You will add one wildcard record.
* An email address for Let's Encrypt.
* One AWS region, used for everything. This guide uses `us-east-1`, where houston's
  prices come from. Create and delete must use the same region.
* About an hour the first time. Most of it is waiting: the create takes 15 to 25
  minutes and the delete 10 to 20.
* houston itself, which needs Node.js 24.10 or newer, and these four tools:

| Tool | Install from | Check it with |
|---|---|---|
| AWS CLI v2 | [docs.aws.amazon.com](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | `aws --version` |
| eksctl | [eksctl.io](https://eksctl.io/installation/) | `eksctl version` |
| kubectl 1.21 or newer | [kubernetes.io](https://kubernetes.io/docs/tasks/tools/) | `kubectl version --client` |
| Helm 3 | [helm.sh](https://helm.sh/docs/intro/install/) | `helm version` |

Install all four before `cluster create`. The create checks for `aws` and `eksctl`
up front, but it needs `kubectl` and `helm` at the end to prepare the cluster.
Without them you are left with a cluster that bills and cannot run a workspace yet.

Then run the preflight:

```bash
houston doctor
```

`doctor` does not check everything EKS needs. It looks at AWS only when `kubectl`
and `helm` are installed and at least one of `aws` or `eksctl` is. If `kubectl` or
`helm` is missing, it prints
`Kubernetes not set up (… not installed) — Compose workspaces are unaffected` and
skips AWS entirely, so a clean report does not mean you are ready for EKS. When it does
check AWS, it reports problems as warnings rather than failures until you have an EKS
cluster in use. The line you are looking for is
`AWS ready — <your identity>, region <region>`, and it appears only once your
credentials work (section 4).

---

## 4 · One-time AWS setup

Three steps, done once per account. You write out the policy, an IAM administrator
creates a user with it, and you sign in as that user.

houston should never run as the AWS **root user**. Root cannot be limited to what
houston needs, and it cannot assume roles. The administrator in step 2 should also be
an IAM administrator rather than root. In a brand-new account where only root can sign
in, root may run step 2 once. Nothing after that uses root.

**Step 1. You write out the permissions.** houston ships the policy it needs:

```bash
houston cluster iam-policy                                   # lists the three documents and what each is for
houston cluster iam-policy operator > operator-policy.json   # the one you need now
```

Give `operator-policy.json` to your IAM administrator. The other two documents,
`engineer` and `rbac`, are for sharing a cluster later (Appendix A).

**Step 2. The IAM administrator creates the user.**

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam create-user --user-name houston-operator
aws iam create-policy --policy-name houston-cluster-operator \
    --policy-document file://operator-policy.json
aws iam attach-user-policy --user-name houston-operator \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/houston-cluster-operator"
aws iam create-access-key --user-name houston-operator
```

The last command prints an access key id and a secret access key. AWS shows the secret
**only once**. Pass both to the engineer over a secure channel.

Use the policy as shipped. It is a customer-managed policy, not an inline one, because
it is too long for an inline user policy. Two of its permissions look unnecessary and
are not (Appendix C).

**Step 3. You sign in as that user.**

```bash
aws configure                 # paste the key id and secret; region: us-east-1; output: json
aws sts get-caller-identity   # the "Arn" must end in :user/houston-operator
```

If this machine already has AWS credentials for something else, keep them apart with a
named profile instead:

```bash
aws configure --profile houston
export AWS_PROFILE=houston    # in every shell you use for this guide
```

Set the region in `aws configure` even though the commands pass `--region`.
`cluster create` refuses to start when the AWS CLI resolves no region, and
`cluster delete` without `--region` looks in the configured one.

houston resolves the region the way the AWS CLI does: `AWS_REGION` first, then
`AWS_DEFAULT_REGION`, then the region `aws configure` set for the profile in use. A
variable left over from other work therefore wins over `aws configure`.

houston never stores, asks for or refreshes an AWS credential. It uses whatever the AWS
CLI finds, so `aws sso login`, the standard environment variables or an instance
profile work as well.

Your account id is the 12-digit number this prints:

```bash
aws sts get-caller-identity --query Account --output text
```

---

## 5 · Approve the account in houston

houston will not build a cluster in an AWS account until you name that account on this
machine. This is a deliberate gate on spending money, and no flag skips it.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
houston config set cluster.approved_accounts "$ACCOUNT_ID"
houston config set acme.email you@example.com
```

Without the first setting, `cluster create` stops with exit code 6 (error code
`GATE_CLOUD_SPEND`) and says the account "has not been told it may spend in that
account". The refusal prints the exact `houston config set` line to run.

`set` replaces the whole list. To approve more than one account, separate them with
commas: `houston config set cluster.approved_accounts 111122223333,444455556666`.
`houston config get cluster.approved_accounts` shows the current list.

The second setting is the contact address Let's Encrypt needs for every `--domain`
workspace.

---

## 6 · Create the cluster

```bash
houston cluster create support --region us-east-1
```

* `support` is the cluster's name. Any name works; use the same one in every later
  command.
* It builds 3 `t3.large` nodes. `--nodes` changes the count (see the prices in
  section 2).
* It tags the cluster with a reminder date 7 days out. `--expires 30` sets another
  number of days, and `--expires never` sets none.
* It takes 15 to 25 minutes and prints progress the whole time. Billing starts now.

What you will see, in order:

1. `building EKS cluster 'support' in us-east-1 — this takes 15–25 minutes and is
   billable, and is tagged as wanted until <date>`
2. eksctl's own progress while it builds the network, the control plane and the nodes.
3. `cluster 'support' is up in us-east-1`, then `kubeconfig kept at …` and
   `set as this box's default cluster …`.
4. The storage class, the ingress controller (Traefik) and cert-manager being
   installed.
5. `point your name at: <address>`. **Copy this address.** It ends in
   `.elb.amazonaws.com`, and section 7 needs it.
6. A closing summary: the cluster is up, its expiry date, and a sample `houston up`
   line.

**If you missed the address**, or the create warned that the load balancer had no
address yet (it can take a few minutes), print it again. This is safe to run as often
as you like:

```bash
houston cluster prepare --context support
```

**The default cluster.** The create saves the cluster as this machine's default
Kubernetes cluster. That default applies to `houston up --runtime kubernetes` without
`--context`. A plain `houston up` still makes a Docker workspace on this machine.
Name the cluster on every command with `--context support`. The cluster's own name is
enough; the full ARN also works.

**The kubeconfig.** houston keeps a kubeconfig for this cluster at
`${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig`. It holds no secret: it
runs `aws eks get-token`, so it only works with your AWS sign-in. Every `kubectl`
command in this guide uses it, like this:

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" kubectl get nodes
```

That should list 3 nodes with the status `Ready`.

Always pin `kubectl` to this file. Your default kubeconfig (`~/.kube/config`) also
gains an entry for the cluster, but its current context is whatever any tool set last,
and it may point at another cluster, even a customer's or a production one. A bare
`kubectl delete` acts on that cluster. `cluster delete` removes the pinned file, so run
every `kubectl` step before it.

**If the create fails part-way**, it exits with code 7. It may already have built a
network, a NAT gateway and a control plane, and those bill. houston keeps a note that
`houston doctor` reports, and section 10 says how to clean up.

---

## 7 · Point DNS at the cluster, once

In your DNS provider, add one record that points a wildcard name at the address from
section 6:

```text
*.rc.example.com.   CNAME   a1b2c3d4e5f6-1234567890.us-east-1.elb.amazonaws.com
```

Use a CNAME, not an A record: the load balancer's IP addresses change. The wildcard
covers every workspace name under `rc.example.com`, so you do this once per cluster,
not once per ticket.

Check it with a public resolver, using a concrete name (a wildcard itself cannot be
looked up):

```bash
dig +short t1234.rc.example.com CNAME @1.1.1.1
dig +short t1234.rc.example.com @1.1.1.1
```

**A good answer:** the first command prints the load balancer's name with a trailing
dot, such as `a1b2c3d4e5f6-1234567890.us-east-1.elb.amazonaws.com.`. The second prints
that name followed by one or more IP addresses.

**If both print nothing,** the record is not visible yet (wait a few minutes and try
again), or it went into the wrong zone or under the wrong name, such as
`*.rc.example.com.example.com`.

**If the first prints nothing and the second prints only addresses** (Cloudflare's,
often starting `104.` or `172.6`), the record is proxied through Cloudflare. Set it to
**DNS only** (the grey cloud). Proxied, the name answers with Cloudflare's addresses and
certificate instead of your cluster's.

No `dig` on this machine? `nslookup -type=CNAME t1234.rc.example.com 1.1.1.1` asks the
same question.

If you ever delete and recreate the cluster, it gets a new load balancer address.
Update the CNAME to the new one.

---

## 8 · Per ticket: create, use and remove a workspace

### Create it

```bash
houston up --version 8.5.1 --name TICKET-1234 --context support \
    --domain t1234.rc.example.com --wait
```

* `--version` is the customer's Rocket.Chat version.
* `--context support` picks the cluster. Naming a cluster already means Kubernetes, so
  `--runtime` is not needed.
* `--domain` is the workspace's public HTTPS name, under your wildcard. cert-manager
  gets a Let's Encrypt certificate for it. The DNS record from section 7 must work
  first.
* `--wait` returns once Rocket.Chat is serving.

**The workspace is on the public internet.** Anyone with the name can reach its sign-in
page. For that reason houston gives a `--domain` workspace a generated admin password
instead of the fixed local one. Read it from `houston info`: the `Login` line shows
`admin / <password>`.

Without `--domain`, a workspace on the cluster is reachable only through a
port-forward from this machine.

**Names are lowercased.** `--name TICKET-1234` makes a workspace called `ticket-1234`,
and houston prints a line saying so. houston commands accept either spelling. In
Kubernetes the names are lowercase:

| What | Name |
|---|---|
| Workspace | `ticket-1234` |
| Namespace | `houston-ticket-1234` |
| Certificate and its Secret | `ticket-1234-tls` |

### Check it

```bash
houston ready --name TICKET-1234          # is Rocket.Chat serving?
houston info --name TICKET-1234           # URL, admin login, TLS
houston cluster status --context support  # what the cluster holds, and its cost
```

To look at it in Kubernetes directly:

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl -n houston-ticket-1234 get pods
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl -n houston-ticket-1234 get pvc
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl -n houston-ticket-1234 get certificate
curl -s https://t1234.rc.example.com/api/info
```

Healthy looks like this: the pods are `Running`, the PVC is `Bound`, the certificate
`ticket-1234-tls` shows `True` under `READY`, and `curl` prints a short JSON reply with
`"success":true`.

If the certificate is not ready, this says what cert-manager is waiting for (usually
DNS):

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl -n houston-ticket-1234 describe certificate ticket-1234-tls
```

### Use it

These work on a cluster workspace the same way they do on Docker:

```bash
houston logs --name TICKET-1234 --tail 50         # Rocket.Chat's logs
houston seed --name TICKET-1234 --profile small   # sample users, rooms and messages
houston api --name TICKET-1234 GET /api/info      # a REST call, already authenticated
houston pat --name TICKET-1234                    # a personal access token
houston backup --name TICKET-1234                 # a dump you can restore later
houston stats --name TICKET-1234                  # CPU and memory
```

`stats` needs metrics-server, which `cluster create` does not install. Without it,
`stats` stops and prints the install command. Run that command against this cluster:

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

The second command `stats` prints, the `--kubelet-insecure-tls` patch, is for kind
only. EKS does not need it.

### Remove it

```bash
houston down --name TICKET-1234 --volumes --yes
```

Always pass `--volumes` on a cluster. Without it, houston uninstalls Rocket.Chat but
keeps the namespace and its disk so a later `up` can reuse the data. That disk keeps
billing, and `cluster delete` will refuse later because the cluster still holds the
workspace. `--yes` skips the confirmation question.

Removing a workspace does not lower the cluster's hourly rate.

---

## 9 · Tear down everything

> **Remove every workspace before you delete the cluster.** Each workspace keeps its
> database on an EBS disk. `houston down --volumes` deletes the disk's claim, and the
> EBS driver inside the cluster then deletes the disk. Delete the cluster with a
> workspace still in it and that driver never runs: the disk survives, unattached,
> invisible to Kubernetes, and bills until someone deletes it in AWS. That is why
> `cluster delete` refuses a cluster that still holds workspaces.

> **Use the region you created the cluster in.** `cluster delete` without `--region`
> looks in the AWS CLI's configured region. In the wrong region it prints
> `no EKS cluster named 'support' — nothing to delete.` while the cluster goes on
> billing somewhere else.

**1. See what the cluster holds,** including your colleagues' workspaces:

```bash
houston cluster status --context support
```

**2. Remove every workspace.** Your own:

```bash
houston down --name TICKET-1234 --volumes --yes
```

A colleague's workspace is recorded on their machine, so they remove it with
`houston down` there. If the owner is not available, delete its namespace, and its disk
goes with it:

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl delete namespace houston-<name>
```

**3. Confirm it is empty.** Run `houston cluster status --context support` again. It
should say `holding   0 workspace(s), 0 volume(s)`.

**4. Release the load balancer.** A load balancer holds network interfaces inside the
cluster's network, and while it exists the network cannot be deleted, so the cluster
delete hangs.

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl delete svc -A --field-selector spec.type=LoadBalancer
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl get svc -A --field-selector spec.type=LoadBalancer
```

The second command should print `No resources found`.

**5. Delete the cluster.**

```bash
houston cluster delete support --region us-east-1
```

It asks you to confirm and names the region; `--yes` skips the question. It takes 10
to 20 minutes and ends with `cluster 'support' is gone`. It also removes the
kubeconfig entries for the cluster, the pinned kubeconfig file and houston's local note, and it
clears this machine's default cluster if that was this one. The files `cluster.yaml`
and `storageclass.yaml` stay in `~/.houston/clusters/support/` as a record of what was
built.

**6. Check that nothing is left.** "The command returned" is not the same as "nothing is
billing", so ask AWS:

```bash
houston cluster list
aws eks list-clusters --region us-east-1
aws ec2 describe-volumes --region us-east-1 --filters Name=status,Values=available \
    --query 'Volumes[].[VolumeId,Size,CreateTime]' --output table
aws elbv2 describe-load-balancers --region us-east-1 \
    --query 'LoadBalancers[].[LoadBalancerName,DNSName]' --output table
aws elb describe-load-balancers --region us-east-1 \
    --query 'LoadBalancerDescriptions[].[LoadBalancerName,DNSName]' --output table
aws ec2 describe-nat-gateways --region us-east-1 --filter Name=state,Values=available \
    --query 'NatGateways[].[NatGatewayId,VpcId]' --output table
aws ec2 describe-addresses --region us-east-1 \
    --query 'Addresses[?AssociationId==null].[AllocationId,PublicIp]' --output table
aws cloudformation list-stacks --region us-east-1 \
    --query "StackSummaries[?starts_with(StackName, 'eksctl-') && StackStatus!='DELETE_COMPLETE'].[StackName,StackStatus]" \
    --output table
```

A clean result: `houston cluster list` reports no clusters and no unread regions,
`aws eks list-clusters` shows an empty `"clusters"` list, and the other commands print
no rows, or only resources you know belong to something else.

If something is left:

| Left behind | What to do |
|---|---|
| An `available` (unattached) EBS volume | Usually a workspace was still in the cluster when it was deleted. Disks houston's workspaces made carry the tag `kubernetes.io/created-for/pvc/name` with a value such as `data-mongodb-0`. The operator policy cannot delete volumes, so an IAM administrator runs `aws ec2 delete-volume --region us-east-1 --volume-id <vol-id>`. |
| A load balancer | `aws elb delete-load-balancer --region us-east-1 --load-balancer-name <name>` (classic), or `aws elbv2 delete-load-balancer --region us-east-1 --load-balancer-arn <arn>` |
| A NAT gateway or an unattached Elastic IP | `aws ec2 delete-nat-gateway --region us-east-1 --nat-gateway-id <id>`, then `aws ec2 release-address --region us-east-1 --allocation-id <id>` |
| An `eksctl-support-…` CloudFormation stack | `eksctl delete cluster --name support --region us-east-1 --wait`. If that says the cluster does not exist, delete the stack itself: `aws cloudformation delete-stack --region us-east-1 --stack-name <stack-name>` |

### When `cluster delete` refuses

`cluster delete` checks five things first. The two about **ownership** cannot be
overridden by any flag. `--force` skips only the three about **what the cluster
holds**.

| Refusal | Exit code | Can `--force` skip it? |
|---|---|---|
| The cluster's tags could not be read, so houston cannot prove it built the cluster | 3 | no |
| The cluster has no `houston.io/managed-by=houston` tag: houston did not build it (error code `GATE_DELETE_UNOWNED`). The message names the `eksctl delete cluster` command its owner can run instead | 6 | no |
| The cluster does not answer, so what it holds cannot be read | 3 | yes |
| The list of workspaces in it could not be read | 3 | yes |
| It still holds workspaces. The message names their owners | 8 | yes |

Before any of these, it stops with exit code 3 if `aws` or `eksctl` is missing, you are
not signed in to AWS, or no region resolves.

Do not reach for `--force` to get past the last refusal. A forced delete of a cluster
that still holds workspaces leaves their disks behind, billing.

### A cluster that was deleted some other way

If a cluster was deleted from the AWS console or by a colleague, your kubeconfig still
has an entry for it, and houston keeps showing a cluster that is not there.
`kubectl config get-contexts` lists the entries. Remove the stale one:

```bash
houston cluster forget arn:aws:eks:us-east-1:123456789012:cluster/support
```

This removes that kubeconfig entry and nothing else. It refuses a cluster that still
answers, because that is a working cluster, not a leftover.

---

## 10 · When it goes wrong

| What you see | What it means, and what to do |
|---|---|
| `cluster create` exits 6: "this box has not been told it may spend in that account" | The account is not approved. Run the `houston config set cluster.approved_accounts` line the message prints (section 5). |
| `cluster create` exits 3: "not signed in to AWS", "no AWS region resolved", or a tool "is not installed" | Fix what the message names. Section 4 covers credentials and the region, section 3 the tools. |
| `cluster create` exits 8: "a cluster named 'support' already exists" | Use that cluster with `--context support`, or pick another name. |
| `cluster create` exits 7, or was interrupted | It may have built billing parts. `houston doctor` shows the note it kept. Run `eksctl delete cluster --name support --region us-east-1 --wait`. If that says the cluster does not exist, check for an `eksctl-support-cluster` CloudFormation stack (section 9, step 6). |
| "the cluster is up but could not be prepared" | The cluster exists and bills, but the last step failed, for example because `kubectl` or `helm` is missing or the cluster was not reachable yet. Fix what the message names, then run `houston cluster prepare --context support`. |
| Every volume stays `Pending` and Rocket.Chat never starts | The cluster was never prepared. Run `houston cluster prepare --context support`. |
| No `point your name at:` line, or "the load balancer still has no address" | The load balancer takes a few minutes. Run `houston cluster prepare --context support` again. |
| `Unauthorized` from every `kubectl` command | AWS let you in and Kubernetes did not. Only the cluster's creator is mapped automatically; everyone else needs an access entry (Appendix A). |
| Even the account's root user gets `Unauthorized` | Same cause. Root has no special standing inside the cluster. |
| The cluster exists, bills, and has no nodes | The node group failed to start, usually because `ec2:RunInstances` was trimmed from the policy. Delete the cluster, restore the shipped policy, and create again. |
| `cluster delete` hangs, or leaves a network behind | A LoadBalancer Service still holds network interfaces. Release it (section 9, step 4). |
| `cluster delete` says `no EKS cluster named 'support' — nothing to delete.` | Probably the wrong region. Run `houston cluster list`, then delete with that `--region`. |
| An EBS volume is left after the cluster is gone | The cluster was deleted with a workspace in it. Delete the volume (section 9, step 6). |
| The certificate is not ready after `up` | Usually DNS. Check section 7, then run the pinned `describe certificate` command in section 8. |
| HTTPS broke after rebuilding the cluster | The new cluster has a new load balancer address. Update the CNAME. |
| The certificate comes from Google Trust Services, not Let's Encrypt | The DNS record is proxied through Cloudflare. Set it to DNS only. |
| MongoDB flaps between `1/1` and `0/1` ready while Rocket.Chat starts | Its readiness probe gives `mongosh` one second, which is tight under load. The database is fine. Ask `houston ready`, not whether every pod is ready. |
| `logging in failed: 401` after several commands in a row | Rocket.Chat briefly blocked the admin account after repeated logins. Wait a few minutes. `houston logs --name TICKET-1234 --tail 200` shows `error-login-blocked-for-user`. |
| `houston stats` refuses: no metrics-server | Install it (section 8, "Use it"). |
| `doctor` no longer mentions a cluster's expiry | Expected on a new `HOUSTON_HOME` or another machine: that reminder comes from a local note. The tag in AWS is the real record, and `houston cluster list` reads it. |

---

## Appendix A · Giving a colleague access

To let a colleague run workspaces on a cluster you built, they need two separate
permissions. The first alone is not enough.

**1. AWS permission** (two read actions). An IAM administrator attaches it:

```bash
houston cluster iam-policy engineer > engineer-policy.json
aws iam put-user-policy --user-name <their-iam-user> --policy-name houston \
    --policy-document file://engineer-policy.json
```

**2. Kubernetes permission.** With only the AWS permission, every `kubectl` command
they run says `Unauthorized`. The cluster's creator is mapped automatically; nobody else
is. You, as the creator, run:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws eks create-access-entry --cluster-name support --region us-east-1 \
    --principal-arn "arn:aws:iam::${ACCOUNT_ID}:user/<their-iam-user>" --type STANDARD \
    --kubernetes-groups houston-engineers
aws eks associate-access-policy --cluster-name support --region us-east-1 \
    --principal-arn "arn:aws:iam::${ACCOUNT_ID}:user/<their-iam-user>" \
    --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy \
    --access-scope type=cluster
houston cluster iam-policy rbac \
    | KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" kubectl apply -f -
```

The last command matters. `AmazonEKSAdminPolicy` covers everything inside a namespace
and stops there. houston needs a little more: it creates a namespace per workspace, and
it reads cluster-wide objects such as storage classes before it creates anything. The
`rbac` document grants that, read-only apart from namespaces.

**3. The colleague** writes a kubeconfig entry for the cluster once, then uses it like
you do:

```bash
aws eks update-kubeconfig --name support --region us-east-1
houston up --version 8.5.1 --name TICKET-5678 --context support \
    --domain t5678.rc.example.com --wait
```

They need `acme.email` set on their machine (section 5), but not
`cluster.approved_accounts`: that setting is only for building clusters.

---

## Appendix B · What `cluster create` builds

The shape follows Rocket.Chat's Launchpad reference for EKS, except the node count:
Launchpad sizes 5 nodes for production, and a reproduction carries one workspace, so
the default is 3.

* **A new network (VPC)**, `10.0.0.0/16`, with a NAT gateway. `--subnet <az>=<subnet-id>`
  (repeatable) uses existing private subnets instead. A new VPC is the kind
  `cluster delete` can remove again.
* **An EKS 1.33 control plane** and a managed node group of `t3.large` nodes on private
  networking. It is a managed node group, not EKS Auto Mode, because EKS-specific
  behaviour (EBS volumes, scheduling) is usually the reason to use EKS at all.
* **The EBS CSI driver** add-on, version 1.47.0, with the IAM OIDC provider it needs to
  create volumes.
* **Tags on the cluster, set at creation:** `houston.io/managed-by=houston`, which is
  what later proves houston may delete it, and `houston.io/expires=<date>`, the
  reminder.
* **Preparation**, which `houston cluster prepare` repeats safely:
  * a `gp3` StorageClass, made the default, but only when the cluster has no default
    class. EKS 1.33 ships a single `gp2` class on a deprecated driver, not marked
    default, so without this every database volume stays `Pending`;
  * the Traefik ingress controller, installed with Helm in the `traefik` namespace. Its
    Service is a LoadBalancer, which makes AWS create the load balancer you point DNS at;
  * cert-manager, which obtains the Let's Encrypt certificates.
* **Files on this machine**, in `~/.houston/clusters/support/`: `cluster.yaml` (the
  exact config handed to eksctl, kept even when the create fails), `storageclass.yaml`,
  `kubeconfig` and `cluster.json` (a local note that `houston doctor` reads).
* **This machine's default cluster** is set to the new one (section 6).

---

## Appendix C · IAM details

**Why a managed policy.** The operator policy is about 4,500 characters. An IAM user's
inline policies are limited to 2,048 characters in total. A customer-managed policy
allows 6,144 and is easier to share between people. An inline policy on a role allows
10,240, which suits an SSO setup.

**Two permissions that look unnecessary and are not.** Do not trim them:

* `ec2:RunInstances`. EKS starts the nodes itself, but it checks that the caller could
  have. Without it you get a cluster with zero nodes that bills at the full rate and
  can run nothing.
* `cloudformation:UpdateTerminationProtection`. It is used only when deleting, and
  without it the delete fails after the cluster is half gone.

**What the operator policy cannot do.** It cannot delete EBS volumes or change IAM
users. Removing a leftover volume (section 9) and granting a colleague AWS access
(Appendix A) both need an IAM administrator.

---

## Appendix D · What is deliberately not automated

**DNS.** Automating the record (for example with external-dns) would mean giving
houston write access to your DNS zone, to save adding one CNAME per cluster.

**Deleting on a timer.** Nothing deletes a cluster when its expiry date passes. A
shared cluster may hold a colleague's work, and a timer should not decide to destroy
it. The expiry tag reminds you; it never acts.
