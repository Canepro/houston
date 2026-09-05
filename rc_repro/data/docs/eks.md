# Rocket.Chat on Amazon EKS — the whole path

Written for somebody who has never used EKS. Follow it top to bottom and you end with
a Rocket.Chat on your own domain with a real certificate, and then with nothing left
behind.

**Who this is for:** whoever runs the commands. It assumes a terminal and an AWS
account, and nothing else.

Ships with rc-repro, so it is on any machine the tool is installed on:
`rc-repro cluster guide` prints it, `rc-repro cluster guide --path` says where it is.

---

## What you are about to build, and what it costs

A **cluster** is a set of machines in AWS that can run containers. EKS is Amazon's
managed version: they run the control plane, you pay for it by the hour.

A **workspace** is one Rocket.Chat — the thing you actually want. Many workspaces live
in one cluster, each in its own namespace, and creating or destroying one is free and
takes minutes.

That difference is why there are two verbs:

| | |
|---|---|
| `rc-repro cluster create` | ~20 minutes, **costs money from the first minute**, once per team |
| `rc-repro up` | ~5 minutes, free, once per ticket |

**`up` can never create a cloud cluster**, under any flag. The command you run several
times a day cannot start something that bills.

A two-node cluster is about **$0.35/hour — $8.46/day** for as long as it exists,
whether or not anything is running in it. Deleting workspaces does not reduce it.
Only `cluster delete` stops it.

---

## 1 · Install the tools

```bash
rc-repro doctor          # names anything missing, and what to do about it
```

You need four: `aws`, `eksctl`, `kubectl`, `helm`. `doctor` checks all of them, plus
the things people forget — disk, memory, Docker, kernel limits.

---

## 2 · Sign in to AWS

rc-repro never stores, prompts for, or refreshes an AWS credential. It uses whatever
your machine already has and tells you which identity it found.

```bash
aws configure            # access key + secret + region, the simplest way in
aws sts get-caller-identity   # prove it worked: prints your account and identity
```

If your company uses SSO, `aws sso login` instead — rc-repro does not care which.

---

## 3 · Make an IAM user for this (do not use root)

**Do not use the root account.** Root cannot be scoped, cannot assume roles
(`Roles may not be assumed by root accounts`), and AWS advises against it. It also
buys you nothing here: a scoped user can do all of this.

You need **one** user to begin with — the *operator*, who builds and destroys
clusters. rc-repro ships the exact policy, verified by using it:

```bash
rc-repro cluster iam-policy                 # what the documents are, and why
rc-repro cluster iam-policy operator > operator-policy.json    # write it out
```

Then, as somebody who can administer IAM (this once, root is acceptable):

```bash
aws iam create-user --user-name rc-repro-operator               # the person
aws iam create-policy --policy-name rc-repro-cluster-operator \
    --policy-document file://operator-policy.json               # the permissions
aws iam attach-user-policy --user-name rc-repro-operator \
    --policy-arn arn:aws:iam::<your-account-id>:policy/rc-repro-cluster-operator
aws iam create-access-key --user-name rc-repro-operator         # the credentials
```

The last command prints an access key id and secret **once**. Put them where the AWS
CLI will find them — `aws configure`, or the environment:

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
aws sts get-caller-identity      # should now say .../rc-repro-operator
```

**Why a managed policy and not an inline one:** the operator policy is about 4,500
characters and an IAM *user's* inline policies are capped at 2,048. A customer-managed
policy allows 6,144, and is how you would share it with several people anyway. A
*role* allows 10,240, which is the better shape if you use SSO.

**Two permissions in that policy are not guessable**, and both were found by a real
build failing without them. Do not trim them:

* `ec2:RunInstances` — EKS starts the nodes itself, and still checks that *you* could
  have. Without it you get a cluster with **zero nodes** that bills at the full rate
  and can run nothing.
* `cloudformation:UpdateTerminationProtection` — needed only when deleting, and it
  fails *after* the cluster is half gone.

---

## 4 · Let rc-repro spend money in this account

```bash
rc-repro config set cluster.approved_accounts <your-account-id>   # the spend gate
rc-repro config set acme.email you@company.com                    # for Let's Encrypt
```

Until the account is named, `cluster create` refuses — and `--force` cannot reach that
gate. Force is a reflex; this is a decision about somebody's bill.

---

## 5 · Build the cluster

```bash
rc-repro cluster create support --region us-east-1 --nodes 2 --expires 7
```

One line, about twenty minutes, and it streams progress rather than going silent.
`support` is just a name; use whatever you like.

What it does, so nothing is a surprise:

* builds a **new VPC** (its own network), unless `--subnet <az>=<subnet-id>` names
  existing ones — a new one is the version `cluster delete` can take away again
* tags the cluster as rc-repro's **at creation**, which is what later proves it is
  safe to delete
* tags an expiry date — a **reminder only**, nothing deletes on it
* then **prepares** it: installs a `gp3` storage class, an ingress controller and
  cert-manager

That preparation matters more than it sounds. EKS ships exactly one storage class, on
a deprecated driver, marked non-default — so without it every database volume stays
`Pending` for ever and Rocket.Chat never starts, with nothing pointing at storage as
the cause.

It also keeps a copy of the cluster's kubeconfig beside the manifests it wrote:

```bash
rc-repro cluster status --context support        # or, straight to kubectl:
KUBECONFIG=~/.rc-repro/clusters/support/kubeconfig kubectl get nodes
```

That file holds no credential — its user runs `aws eks get-token`, so it is useless
without your AWS sign-in. It is there so nobody has to know to run `aws eks
update-kubeconfig` to get back to a cluster.

When it finishes it prints a **load balancer address**. Keep it for the next step.

---

## 6 · Point DNS at the cluster — once per cluster

Add one record in your DNS provider:

```
*.rc.yourcompany.com   CNAME   a1b2c3d4….us-east-1.elb.amazonaws.com
```

A wildcard covers every workspace the cluster will ever hold, so you do this once, not
once per ticket.

```bash
dig +short t1234.rc.yourcompany.com CNAME @1.1.1.1   # ask a public resolver, not your cache
```

Query a **concrete** name, not the wildcard — a wildcard record is not itself
resolvable, and asking `1.1.1.1` rather than your machine skips a local cache that may
still hold the old answer.

Two things that catch people:

* If you use **Cloudflare**, set the record to **DNS only** (grey cloud). Proxied, it
  serves Cloudflare's certificate and the name never reaches your cluster.
* **Recreating a cluster gives a new address.** The CNAME has to follow it.

This step is manual on purpose: automating it means handing rc-repro write access to
your DNS zone to save fifteen seconds, once.

---

## 7 · Create a workspace

```bash
rc-repro up --version 8.5.1 --name TICKET-1234 \
    --context support --domain t1234.rc.yourcompany.com --wait
```

* `--context support` — which cluster. **The cluster's own name is enough**; the long
  ARN works too.
* `--domain` — the public name. cert-manager gets a real Let's Encrypt certificate for
  it, and TLS terminates inside the cluster.
* `--wait` — block until Rocket.Chat is actually serving.

You do **not** need `--runtime kubernetes`: naming a cluster already says Kubernetes.
Note the opposite, though — **a bare `up` is always Docker**, whatever cluster is
saved as this machine's default. Naming the cluster is the only unambiguous form.

Without `--domain` a workspace is reachable only by a port-forward: tied to a pod,
gone when it restarts, one person at a time. On a cluster you are paying for, that
wastes the point of it.

In the browser (`rc-repro serve`): **+ New workspace** → section 2 → the **Kubernetes**
card → the **Cluster** picker, which marks which clusters cost money.

---

## 8 · Check it

```bash
rc-repro ready --name TICKET-1234        # is Rocket.Chat serving?
rc-repro info  --name TICKET-1234        # URL, admin login, where it runs
rc-repro cluster status --context support   # what the cluster holds, and the hourly cost
```

Straight from Kubernetes, when you want to see for yourself:

```bash
kubectl -n rc-repro-TICKET-1234 get pods                          # what is running
kubectl -n rc-repro-TICKET-1234 get pvc                           # is the volume Bound?
kubectl -n rc-repro-TICKET-1234 describe certificate TICKET-1234-tls   # cert-manager
curl -sI https://t1234.rc.yourcompany.com/api/info                 # does the name serve?
```

---

## 9 · Everyday use

All of these work on a Kubernetes workspace exactly as on Docker:

```bash
rc-repro logs --name TICKET-1234 --tail 50      # Rocket.Chat's own logs
rc-repro seed --name TICKET-1234 --profile small  # rooms, users, messages to test with
rc-repro api  --name TICKET-1234 GET /api/info  # any REST call, authenticated for you
rc-repro pat  --name TICKET-1234                # a personal access token
rc-repro stats --name TICKET-1234               # CPU and memory (needs metrics-server)
rc-repro backup --name TICKET-1234              # dump it out, restorable later
```

---

## 10 · Remove the workspace

```bash
rc-repro down --name TICKET-1234 --volumes --yes
```

Removes the namespace and its volumes. **It does not remove the cluster**, which keeps
costing money.

---

## 11 · Remove the cluster — this is what stops the bill

```bash
kubectl delete svc -A --field-selector spec.type=LoadBalancer   # release the ELBs FIRST
rc-repro cluster delete support --region us-east-1 --yes
```

Skip the first line and the load balancers keep network interfaces attached, so the
VPC delete hangs.

`cluster delete` refuses six ways: if the tag does not prove rc-repro built it, if that
tag could not be read, if the cluster cannot be read, if the workspace list is
unreadable, or if it still holds workspaces — naming whose. `--force` is the only
override.

**Remove the workspaces first, and mean it.** That last refusal is not bureaucracy.
A workspace's database volume is an EBS volume, and the EBS driver deletes it when the
PERSISTENTVOLUMECLAIM goes. Destroy the cluster with the workspace still in it and the
driver never runs: the volume survives, unattached, and bills for ever. Measured — a
forced delete of a cluster holding one workspace left an 8 GB volume behind, tagged
`created-for/pvc/name: data-mongodb-0`, which nothing in Kubernetes could then see.

Then confirm, because "the command returned" is not the same as "nothing is running":

```bash
rc-repro cluster list                        # every region, by tag
aws eks list-clusters --region us-east-1     # ask AWS directly
```

`cluster delete` also clears the kubeconfig entries it wrote — both of them, since
`eksctl` and `aws eks update-kubeconfig` each write their own name for the same
cluster — and the `current-context` pointer if it named the cluster you just removed.
Without that the ledger goes on listing a cluster that no longer exists, and every
`kubectl` reports "not answering" about something that is simply not there.

For a cluster that went away some other way — deleted from the console, or by a
colleague — the entry is still on your machine and nothing has cleaned it up:

```bash
rc-repro cluster forget arn:aws:eks:us-east-1:123456789012:cluster/support
```

That removes the kubeconfig entry and nothing else. It refuses a cluster that still
answers, because at that point the name is a working cluster rather than litter.

---

## What it costs

| Component | Rate | A 2-node cluster |
|---|---|---|
| EKS control plane | $0.100/hr | $0.100 |
| NAT gateway | $0.045/hr | $0.045 |
| Nodes — `t3.large` | $0.0832/hr each | $0.166 |
| Node volumes — 80 GB gp3 each | $0.08/GB-month | $0.018 |
| Load balancer | $0.0225/hr | $0.023 |
| **Total** | | **~$0.35/hr · ~$8.46/day** |

`rc-repro cluster status` prices the cluster you point it at and never reports a zero
it could not read — an unreachable cluster shows `?`, not "empty".

**To find clusters you have forgotten**, in regions you are no longer thinking about:

```bash
rc-repro cluster list      # sweeps every region your account has enabled
```

Read the bottom of that output as carefully as the top: a region it could not ask is
listed separately and is **not** covered by the report.

---

## Letting somebody else use your cluster

Everything above assumes one person. To let a colleague run workspaces on a cluster
**you** built, they need two separate things — and this is the part that surprises
everybody:

**One — AWS permission**, which is two read actions:

```bash
rc-repro cluster iam-policy engineer > engineer-policy.json
aws iam put-user-policy --user-name <them> --policy-name rc-repro \
    --policy-document file://engineer-policy.json
```

**Two — Kubernetes permission.** IAM gets them a kubeconfig and the cluster still says
`Unauthorized`. Whoever created the cluster is mapped automatically; nobody else is.

```bash
aws eks create-access-entry --cluster-name support --region us-east-1 \
    --principal-arn arn:aws:iam::<acct>:user/<them> --type STANDARD \
    --kubernetes-groups rc-repro-engineers
aws eks associate-access-policy --cluster-name support --region us-east-1 \
    --principal-arn arn:aws:iam::<acct>:user/<them> \
    --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy \
    --access-scope type=cluster
rc-repro cluster iam-policy rbac | kubectl apply -f -
```

That last line matters: AWS's `AmazonEKSAdminPolicy` is admin *inside* a namespace and
stops there. rc-repro crosses that line on every `up` — a namespace per workspace is
the whole model, and it reads storage classes before creating anything.

---

## When it goes wrong

| What you see | What it is |
|---|---|
| Every volume `Pending`, Rocket.Chat never starts | the cluster was never prepared — `rc-repro cluster prepare --context support` |
| `Unauthorized` from every `kubectl` | AWS permission passed, Kubernetes permission did not — you need an access entry |
| Even the account root gets `Unauthorized` | only the cluster's creator is mapped automatically; root is not special here |
| A cluster exists, bills, and has no nodes | the node group failed — usually a missing `ec2:RunInstances` |
| `cluster delete` hangs, or leaves a VPC | a LoadBalancer service still holds network interfaces — delete those services first |
| An EBS volume left behind after the cluster is gone | the cluster was deleted while a workspace was still in it, so the CSI driver never released its volume. `rc-repro down` first; check with `aws ec2 describe-volumes --region <r> --query 'Volumes[?State==\`available\`].VolumeId'` |
| HTTPS broke after rebuilding a cluster | new cluster, new load balancer address; repoint the CNAME |
| The certificate is from Google Trust Services | the DNS record is proxied through Cloudflare — set it to DNS only |
| MongoDB flapping `1/1 → 0/1` while RC boots | its readiness probe allows one second for `mongosh`, which is tight under load. The database is fine; ask `rc-repro ready`, not "are all pods ready" |
| `logging in failed: 401` after several commands in a row | Rocket.Chat temporarily blocked the admin account after repeated logins. Wait a few minutes; `kubectl logs` shows `error-login-blocked-for-user` |
| `doctor` no longer mentions a cluster's expiry | expected on a fresh `RC_REPRO_HOME` — the tag in AWS is the authority, the local note is a convenience |

---

## What is deliberately not automated

**external-dns** — it would need write credentials to your DNS zone, to replace one
CNAME per cluster.

**An idle sweep** — nothing should decide on a timer to destroy a cluster that may
hold a colleague's work. The expiry tag reminds; it never acts.
