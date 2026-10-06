# Rocket.Chat on Amazon EKS

An EKS cluster is a Kubernetes cluster in your AWS account. **It bills by the hour from
the moment it exists until it is deleted**, whether or not anything runs on it. Build one
per team, run a workspace per ticket, and delete it when you are done.

`houston cluster guide` prints this page. `houston cluster overview` shows every cluster,
what it costs and what to do next. `houston up` never creates a cluster; only
`houston cluster create` does.

---

## What you need, once

* The four tools: [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
  [eksctl](https://eksctl.io/installation/), [kubectl](https://kubernetes.io/docs/tasks/tools/)
  and [Helm](https://helm.sh/docs/intro/install/).
* An AWS sign-in that is **not the root user** (setup below).
* A DNS zone you can edit, such as `rc.example.com`, and an email for Let's Encrypt.

```bash
aws --version; eksctl version; kubectl version --client; helm version
houston doctor        # look for: AWS ready — <your identity>, region <region>
```

**AWS sign-in, the first time.** An IAM administrator creates a user with houston's
policy, and you sign in as it:

```bash
houston cluster iam-policy operator > operator-policy.json     # give this to the IAM admin

# The IAM admin runs:
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam create-user --user-name houston-operator
aws iam create-policy --policy-name houston-cluster-operator --policy-document file://operator-policy.json
aws iam attach-user-policy --user-name houston-operator \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/houston-cluster-operator"
aws iam create-access-key --user-name houston-operator        # the secret is shown only once

# You run:
aws configure                    # the key id and secret; region us-east-1; output json
aws sts get-caller-identity      # the Arn must end in :user/houston-operator
```

Company SSO (`aws configure sso`, then `aws sso login`) or a server role works instead.
Use the policy exactly as shipped.

---

## Build a cluster

**1. Approve the account on this machine** (once). houston will not spend in an account
until you name it here:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
houston config set cluster.approved_accounts "$ACCOUNT_ID"
houston config set acme.email you@example.com
```

**2. Create the cluster.** 15 to 25 minutes, **billing from now**:

```bash
houston cluster create support --region us-east-1 --zone rc.example.com
```

| Option | Default | What it does |
|---|---|---|
| `--nodes` | 3 | how many `t3.large` nodes |
| `--expires` | 7 | days until a reminder; `never` for none. Nothing deletes on it |
| `--zone` | none | the DNS zone workspace names live under |
| `--region` | the AWS CLI's | where to build |

It ends with `point your name at: <address>.elb.amazonaws.com`. **Copy that address.**
Missed it? `houston cluster prepare support` prints it again.

**3. Point DNS at it** (once per cluster). Add one record at your DNS provider:

| Field | Value |
|---|---|
| Type | `CNAME`, not an A record: the load balancer's addresses change |
| Name | `*.rc.example.com`. Most providers, Cloudflare included, want only the part before your domain: for `example.com`, type `*.rc` |
| Target | the address from step 2 |
| Proxy | **DNS only** (Cloudflare's grey cloud). Ignore Cloudflare's warning that this exposes your origin: the target is a public AWS load balancer, and the proxy breaks the workspaces' certificates |

houston checks it by looking up `houston-probe.rc.example.com`, a name you do not create.
In the GUI, Home, the cluster's card and its page offer **Set up DNS** until it answers.

**4. Check it.** The overview says when the name answers:

```bash
houston cluster overview
houston cluster status support
```

---

## A workspace per ticket

```bash
houston up --version 8.5.1 --name TICKET-1234 --context support --wait
houston info --name TICKET-1234           # URL and admin login
```

* Its public name is `ticket-1234.rc.example.com`, from the zone. `--domain <name>`
  picks another.
* A public workspace gets a generated admin password; `houston info` shows it.
* Grafana: `houston monitor --name TICKET-1234`, then open
  `https://ticket-1234.rc.example.com/grafana` (admin / admin).

The usual commands work on it:

```bash
houston logs --name TICKET-1234 --tail 50
houston seed --name TICKET-1234 --profile small
houston api --name TICKET-1234 GET /api/info
houston stats --name TICKET-1234
houston backup --name TICKET-1234
```

**Remove it, always with `--volumes`:**

```bash
houston down --name TICKET-1234 --volumes --yes
```

Without `--volumes` its 8 GB disk stays and keeps billing, and `cluster delete` will
refuse later.

---

## Stop the bill: delete the cluster

```bash
houston cluster status support                     # 1. what it still holds, colleagues' too
houston down --name TICKET-1234 --volumes --yes    # 2. remove every workspace
houston cluster delete support                     # 3. 10 to 20 minutes
houston cluster list                               # 4. nothing left in any region
```

`cluster delete` releases the load balancer, deletes the cluster, then checks AWS and
ends with `nothing in us-east-1 is billing`, or a `left behind` row per leftover with the
command that removes it. It refuses a cluster that still holds workspaces; do not use
`--force` to get past that, or their disks stay behind and bill.

A colleague's workspace is removed by them (`houston down`), or by deleting its
namespace:

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" kubectl delete namespace houston-<name>
```

---

## What it costs

us-east-1, on demand, the rates houston's own estimates use:

| | 3 nodes (default) | `--nodes 2` | `--nodes 5` |
|---|---|---|---|
| Per hour | $0.44 | $0.35 | $0.63 |
| Per day | $10.64 | $8.43 | $15.06 |
| Per month | about $324 | about $257 | about $458 |

Most of it is the nodes ($0.0832 an hour each), then the EKS control plane ($0.10 an
hour: houston builds Kubernetes 1.37, on standard support until December 2027), a NAT
gateway and the load balancer. A cluster an older houston built at 1.33 bills $0.60 an
hour for its control plane (extended support since 29 July 2026), about $12 a day more.
Each workspace adds an 8 GB disk, about $0.64 a month. Data transfer is extra.

**These do not stop the bill:** removing workspaces, leaving the cluster idle, or the
expiry date (`houston cluster keep support --days 7` moves it). **Only
`houston cluster delete` does.**

---

## Use a cluster that already exists

```bash
houston cluster list --force                                          # every EKS cluster in the account
houston cluster connect arn:aws:eks:us-east-1:123456789012:cluster/support
houston cluster status --context support
houston up --version 8.5.1 --name TICKET-1234 --context support --wait
```

Connecting is free. Your AWS identity also needs an EKS access entry on that cluster:
its owner grants it in AWS, or with `houston cluster share` if houston built it (next
section). houston deletes only clusters it built.

---

## Give a colleague access

```bash
houston cluster iam-policy engineer > engineer-policy.json      # an IAM admin attaches it:
aws iam put-user-policy --user-name <their-iam-user> --policy-name houston \
    --policy-document file://engineer-policy.json
houston cluster share support --user <their-iam-user>           # you, the cluster's creator
```

`share` prints the two lines they run:

```bash
aws eks update-kubeconfig --name support --region us-east-1
houston up --version 8.5.1 --name TICKET-5678 --context support --wait
```

They need `acme.email` set, not `cluster.approved_accounts`. `share` works only on a
cluster houston built.

---

## When it goes wrong

| You see | Do this |
|---|---|
| `cluster create` exits 6: "has not been told it may spend" | Run the `houston config set cluster.approved_accounts` line it prints. |
| `cluster create` exits 3: not signed in, no region, or a tool missing | Fix what it names. Nothing was built. |
| `cluster create` exits 8: the name already exists | Use it with `--context support`, or pick another name. |
| `cluster create` exits 7 or was interrupted | It may be billing. Run the `houston cluster delete support --region us-east-1` it names. |
| No `point your name at:` line, or volumes stay `Pending` | Run `houston cluster prepare support`. |
| The overview says DNS does not answer | The CNAME is missing, not visible yet, or proxied (step 3). |
| The certificate is not ready after `up` | Usually DNS. Then run the `describe certificate` line below. |
| `Unauthorized` from `kubectl` | AWS let you in, Kubernetes did not: you need an access entry (`cluster share`). |
| `cluster delete` says "nothing to delete" | It is in another region: `houston cluster list`, then `--region`. |
| `cluster delete` refuses: it holds workspaces | Remove them first (`houston down --volumes`), then delete again. |
| A disk is left after the cluster is gone | The cluster was deleted with a workspace in it. The delete's `left behind` row has the command. |
| The overview says a cluster reached its expiry date | A reminder only. `houston cluster keep support --days 7`, or delete it. |
| A cluster was deleted outside houston | `houston cluster forget support` removes its kubeconfig entry. |

```bash
KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clusters/support/kubeconfig" \
    kubectl -n houston-ticket-1234 describe certificate ticket-1234-tls
```

---

## Reference

**AWS credentials.** houston uses whatever the AWS CLI finds on the machine it runs on,
and never stores a key. The GUI acts as the server's AWS identity for every user and
never asks for keys; set up SSO, a role or `aws configure` on the server.

**What `create` builds.** A new VPC with a NAT gateway (`--subnet <az>=<subnet-id>` uses
existing subnets), an EKS 1.37 control plane, a managed node group of `t3.large`, the
EBS driver, then a `gp3` storage class, Traefik (the load balancer), cert-manager and
metrics-server. The cluster is tagged `houston.io/managed-by=houston`; that tag is what
lets houston delete it. Files are kept in `~/.houston/clusters/support/`, including a
`kubeconfig`. Your own `kubectl` context is left where it was.

**IAM.** Keep `ec2:RunInstances` and `cloudformation:UpdateTerminationProtection` in the
policy even though they look unused: without the first the cluster gets no nodes, and
without the second the delete fails half-way. The operator policy cannot delete EBS
volumes or change IAM users; an IAM admin does those.

**In the GUI.** Clusters → **Set up Amazon EKS** does steps 1 and 2 and shows the DNS
record. A cluster's own page has **Create a workspace here**, **Public names (DNS)** and
**Delete cluster…**. **New workspace** lists the EKS cluster under **In AWS**.
