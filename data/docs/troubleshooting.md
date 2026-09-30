# Troubleshooting

Find the symptom, then the fix. **Start with `houston doctor`:** it checks the machine
and names most of what follows before you run into it.

On EKS, the [EKS guide](eks.md#10--when-it-goes-wrong) has its own list.

**Contents:** [Installing](#installing) · [Nothing starts](#nothing-starts) ·
[HTTPS and certificates](#https-and-certificates) · [Kubernetes](#kubernetes) ·
[Cost and cleanup](#cost-and-cleanup) · [The web GUI](#the-web-gui) ·
[Engines and images](#engines-and-images)

---

## Installing

### `houston --version` prints someone else's version

Another npm package, `@rocket.chat/houston`, also installs a command called `houston`.
Whichever comes first on your `PATH` runs. `command -v houston` shows which one that
is. Uninstall the one you do not want, or put this one first on your `PATH`.

### An old houston still runs after installing 2.x

houston 1.x and rc-repro were installed with pipx, and an npm install does not replace
a pipx command. See [Upgrading](upgrading.md#replacing-an-older-install).

### Behind a proxy

Run houston as `houston` (or `bin/houston` from a clone), not with `node` directly.
That launcher makes Node use `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, and passes a
CA bundle named by `REQUESTS_CA_BUNDLE` or `CURL_CA_BUNDLE` to Node as
`NODE_EXTRA_CA_CERTS`. Without that, `houston versions` falls back to the shipped list
and `houston doctor` reports the release endpoint as unreachable. A variable you set
yourself is left alone.

---

## Nothing starts

### `up` refuses before it creates anything

Read the refusal: it names the fix. Most refusals are a check doing its job.

| It says | It means |
|---|---|
| something about **memory** | the machine does not have room for another workspace. Remove one you are finished with (`houston down --name <name> --volumes`) or close something |
| a **port** is in use | another workspace or program holds it. `--port` picks your own; without it houston picks a free one |
| the **Docker daemon** is not running | start Docker Desktop, or `sudo systemctl start docker` |
| `--fresh` is not supported on Kubernetes | it means "delete this workspace's data", and Kubernetes keeps the volume. Run `houston down --name <name> --volumes` first |

### The workspace starts but Rocket.Chat never answers

```bash
houston logs  --name <name> --tail 100
houston stats --name <name>
```

The most common cause is the container being restarted for lack of memory: a climbing
restart count is the sign. `houston doctor` reports how much memory is free.

### `up` succeeded but the Kubernetes URL does nothing

A Kubernetes workspace is reached through a port-forward that is tied to its pod. When
the pod moves (an upgrade, a node event), the forward goes with it:

```bash
houston ready --name <name>      # starts the forward again
```

During an upgrade you may see *"the port-forward dropped while the pod was moving"*:
it is coming back. *"something else already holds it"* is a real clash, and
`ss -ltnp | grep <port>` names the program.

### "`<name>` already exists and is reused as-is"

`up` on an existing name brings back that workspace as it was, and ignores a different
version or preset. Use `houston upgrade` for another version, or a new `--name`.

---

## HTTPS and certificates

### "the ingress controller's built-in placeholder certificate"

cert-manager has not issued the certificate yet. On a new cluster that is normal for a
minute or three.

```bash
houston tls-status --name <name>                              # check again
kubectl -n houston-<name> get certificate                      # what it is waiting for
```

If it stays that way for more than a few minutes, the certificate order is stuck, and
the usual cause is the next entry.

### Let's Encrypt never validates

The name must resolve to the right place, with port 443 reachable, **before** you
create the workspace: Let's Encrypt checks by connecting to it.

- On a cloud cluster, point the record at the load balancer
  `houston cluster prepare --context <cluster>` prints, not at your machine.
- On Cloudflare, set the record to **DNS only** (grey cloud). Proxied, Cloudflare
  serves its own certificate and the name never reaches your cluster.
- Check from outside your own cache: `dig +short <name> @1.1.1.1`.
- A recreated cluster has a new address. Update the record.

### "something in front is terminating TLS for this name"

The certificate was issued, but the name still answers with another one. Something
between the internet and your cluster is intercepting the connection: a proxy, a CDN,
or another program holding the ports. `houston doctor` names a cluster that holds them.

### The browser warns about a local certificate

Expected until you run `houston trust-ca` once. A phone cannot use houston's local
certificates at all; use `--domain` for anything you need to open on a device.

### There is no "Local certificate" option in the GUI

The cluster you picked is not on this machine. That option signs with houston's own
certificate authority, and its private key must not leave this machine. Use a domain
instead.

---

## Kubernetes

Namespaces and names are lowercase: a workspace called `TICKET-1234` lives in
`houston-ticket-1234`.

### `--context support`: "no kubeconfig context named"

Your kubeconfig has no entry for that cluster. For EKS:

```bash
aws eks update-kubeconfig --name support --region us-east-1
```

After that, the short name works: `--context support`.

### kubectl works but helm says "cluster unreachable"

A kubeconfig left from an earlier install of the same cluster does this. Regenerate it:

```bash
sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config     # k3s
kind export kubeconfig --name <cluster>                 # kind
```

`houston doctor` reports the same thing. Fix it before `up`, or the create builds a
namespace and a database, fails at the chart, and rolls everything back.

### Every volume stays `Pending` and Rocket.Chat never starts

The cluster has no **default** StorageClass. EKS ships only `gp2`, not as default:

```bash
houston cluster prepare --context <cluster>
```

### A colleague gets "access denied" on a cluster that works for you

IAM decides whether someone may build a cluster; the cluster's own access entries
decide whether they may use it. The creator is added automatically, everyone else
needs an entry. The [EKS guide](eks.md) has the steps, and these print the policies:

```bash
houston cluster iam-policy engineer     # the IAM half
houston cluster iam-policy rbac         # the in-cluster half
```

### "no matching manifest for linux/arm64", or a refusal about architecture

Rocket.Chat below 8.0.0 is published for amd64 only, so an arm64 node (such as AWS
Graviton) cannot run it. Add an amd64 node group, use Rocket.Chat 8.0.0 or newer, or
use the Docker runtime, which emulates amd64 on an Apple Silicon Mac.

### A refusal about the chart being "from another era"

Below Rocket.Chat 3.7.2 the only Helm chart predates the settings houston needs. Use
the Docker runtime for those versions.

### `env --set` or `seed --scale` refuses

Both work on Docker workspaces only. The refusal names what to use instead: a
`helm upgrade` or `houston api` for settings, and `houston seed --name <name>` for data.

---

## Cost and cleanup

A cloud cluster bills from its first minute, whether or not anything runs in it. Only
`houston cluster delete` stops the bill.

### "Have I left anything running?"

```bash
houston list             # workspaces on this machine
houston cluster list     # cloud clusters, in every enabled AWS region
```

Read the end of the `cluster list` output as carefully as the start. A region that
could not be asked is listed separately, and it is **not** covered by the answer.
`--force` also shows clusters houston did not build.

### `doctor` says it has no local record of a cloud cluster

That does not mean there is none. The local record is lost with a new `HOUSTON_HOME`,
a rebuilt machine, or a cluster made elsewhere. Ask AWS with `houston cluster list`.

### `cluster delete` refuses because the cluster still holds workspaces

Remove them first. Each workspace's database is an EBS volume, and it is only deleted
when the workspace is. Delete the cluster with a workspace still in it and the volume
survives, unattached, and keeps billing. The [EKS guide](eks.md#9--tear-down-everything)
has the full order.

### A deleted cluster is still listed

A cluster deleted outside houston (the AWS console, a colleague) leaves its kubeconfig
entry behind:

```bash
houston cluster forget <context>
```

That removes the local entry and nothing else. It refuses a cluster that still answers.
In the GUI, the card says **gone** and offers to forget it.

---

## The web GUI

### A cluster card shows `?` for a few seconds

By design. The page draws at once and each card fills itself in. `?` means "not read
yet" or "could not be read", never zero; a card that cannot read its cluster says why.

### The log field shows nothing for a while

Long steps report what they are doing, for example *"still installing (1m30s)"*. If
nothing appears for more than a minute or two, check the job in the Activity list and
`houston logs --name <name>`.

### A control I expected is not there

Options a runtime or cluster cannot honour are removed, not greyed out. The Advanced
section says what was removed and why.

### `serve` refuses to start on a reachable address

Either nothing protects the sign-in (see [Reaching it from another
machine](gui.md#reaching-it-from-another-machine)), or there are no accounts yet: the
one-time setup link only works while `serve` listens on this machine alone. Create the
first account first, then open it up.

---

## Engines and images

### Apple Silicon

Only the MongoDB image for MongoDB below 8 (Rocket.Chat below 8) is amd64 only, so it
runs emulated and boots more slowly. Everything else runs natively.

### Podman

Podman works through its Docker socket helper (`podman-mac-helper` on a Mac).

### MongoDB 8 fails to start on a new kernel

Linux kernel 6.19 and newer cannot run MongoDB 8.0
([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). `houston doctor`
warns when it sees this. Use an engine on an older kernel until MongoDB ships a fix.

### Docker Hub rate limits

Anonymous pulls from Docker Hub are rate-limited, and `registry.rocket.chat` counts
against Hub too. Run `docker login`. `up` names this cause directly rather than
reporting a bare pull failure.
