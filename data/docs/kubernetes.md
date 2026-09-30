# Workspaces on Kubernetes

houston can run a workspace on Kubernetes instead of Docker, with the Rocket.Chat Helm
chart, including Rocket.Chat split into microservices. Use it when a ticket is about
Kubernetes, the chart, or the microservices deployment. For everything else, Docker is
faster and lighter.

For a cloud cluster on AWS, read [Rocket.Chat on EKS](eks.md) as well. A cloud cluster
costs money, and houston never creates one as a side effect of `up`.

**Contents:** [Before you start](#before-you-start) ·
[Start a workspace](#start-a-workspace) · [Which cluster it uses](#which-cluster-it-uses) ·
[What Kubernetes refuses](#what-kubernetes-refuses) ·
[HTTPS on a cluster](#https-on-a-cluster) · [Looking inside](#looking-inside) ·
[Removing it](#removing-it)

---

## Before you start

On top of what the [README](../../README.md#before-you-start) lists, you need:

- `kubectl` and `helm` on your `PATH`.
- **Either** [kind](https://kind.sigs.k8s.io/) installed, so houston can create and
  manage its own local cluster, **or** a cluster your `kubectl` already reaches, such
  as [k3s](https://k3s.io/), minikube or Docker Desktop.
- More memory than a Docker workspace. houston's own kind cluster adds about 600 MB the
  first time.

Then check what houston sees:

```bash
houston doctor
```

It names the cluster it will use and what that cluster provides: storage, an ingress,
a load balancer and metrics. A stock k3s has all four; a stock kind cluster has storage
only.

---

## Start a workspace

```bash
houston up --version 8.5.1 --name ticket-1234 --runtime kubernetes --wait                       # microservices
houston up --version 8.5.1 --name ticket-1234 --runtime kubernetes --deployment monolith --wait # one Rocket.Chat pod
```

| `--runtime` | `--deployment` | What you get |
|---|---|---|
| `docker` (default) | `monolith` (default) | Rocket.Chat and MongoDB, two containers |
| `docker` | `multi-instance` | several Rocket.Chat instances behind a load balancer, with NATS |
| `kubernetes` | `microservices` (default) | the Helm chart, about 9 pods |
| `kubernetes` | `monolith` | the Helm chart, about 5 pods |

- Each Kubernetes workspace is a namespace, `houston-<name>`, in a cluster that all of
  them share.
- You reach it on `http://localhost:<port>`, through a `kubectl port-forward` that
  houston starts. `houston info` prints the address.
- houston keeps **its own kubeconfig** under `~/.houston`, so it never changes the
  context your own `kubectl` uses.
- `--mongo-operator` runs MongoDB under the official community operator, with SCRAM
  authentication (MongoDB 6.0 or newer). Without it, MongoDB is a plain StatefulSet
  with no authentication.
- `--replicas` sets how many Rocket.Chat instances run.

`houston capabilities` lists which runtime and deployment pairs this build accepts. An
invalid pair is refused before anything is created.

---

## Which cluster it uses

- **`--context <name>`** picks a cluster from your kubeconfig, and implies
  `--runtime kubernetes`. Naming a cluster never creates one. The workspace remembers
  its cluster, so later commands for it go there.
- **`houston config set kubernetes.context <name>`** makes that cluster the default
  for `--runtime kubernetes` on this machine.
- **With neither:** if kind is installed, houston creates and manages its own cluster,
  `houston-local`. If kind is not installed, houston uses the cluster your `kubectl`
  points at, creates namespaces there, and never changes the cluster itself.
- **With both kind and another cluster present, kind wins.** Pass `--context` to use
  the other cluster.

Everything after choosing the cluster is the same code, whichever cluster it is.

---

## What Kubernetes refuses

Each refusal says why and what to do instead.

| Refused | Why | Instead |
|---|---|---|
| `up --fresh` | it means "delete this workspace's data", and the Kubernetes path keeps the volume | `houston down --name <name> --volumes`, then `up` again |
| `loadtest`, `capacity` | the traffic would pass through one port-forward, which saturates long before Rocket.Chat does | load-test a Docker workspace on the same version |
| `env --set`, `--setting`, `--unset` | an environment variable is a Helm value here | the `helm upgrade` the refusal prints, or `houston api` for a setting |
| `seed --scale` | the bulk insert works on Docker only | `houston seed --name <name>`, which works on both |
| `up --https` on a cluster that is not on this machine | houston's own CA key would have to leave this machine | `--domain`, below |

`stats` works when the cluster has metrics-server. When it does not, `stats` says how
to install it.

These work on both runtimes: `logs`, `env` (reading), `upgrade`, `backup`, `restore`,
`seed`, `monitor`, `api`, `pat` and `token`.

Two version limits come from Rocket.Chat itself:

- **Below 8.0.0, Rocket.Chat images are amd64 only.** An arm64 node, such as AWS
  Graviton, cannot run them. On an Apple Silicon Mac, the Docker runtime emulates amd64;
  a cluster node cannot.
- **Below 3.7.2, no usable Helm chart exists**, so houston refuses. Use Docker for
  those versions.

---

## HTTPS on a cluster

`--domain` works on Kubernetes. The chart's Ingress serves the name, cert-manager gets
a Let's Encrypt certificate, and TLS ends inside the cluster.

```bash
houston up --version 8.5.1 --name ticket-1234 --runtime kubernetes \
  --domain t1234.example.com --email you@example.com --wait
houston tls-status --name ticket-1234
```

- The name has to point at the cluster's ingress before you run `up`, because Let's
  Encrypt checks it by connecting from outside.
- Right after `up`, the ingress may serve its own placeholder certificate for a minute
  or three, until cert-manager has one. `tls-status` exits 1 and says so. Run it
  again; if it persists, the certificate order is stuck.
- A cluster with more than one ingress controller: houston uses the one the cluster
  marks as default and says which. `--ingress-class nginx` picks one yourself.
- A `--domain` workspace can be reached by anyone who can reach that name, so it gets a
  generated admin password. `houston info` shows it.
- For a kind cluster on this machine, the shared edge still holds ports 80 and 443 and
  passes the connection through without decrypting it, so `houston edge logs` does not
  show that name.

---

## Looking inside

With houston's own kind cluster, point `kubectl` at houston's kubeconfig. With your own
cluster, your usual `kubectl` works. Namespaces and names are lowercase:

```bash
export KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clients/kubernetes/config"   # only for houston's kind cluster
kubectl -n houston-ticket-1234 get pods
kubectl -n houston-ticket-1234 describe certificate ticket-1234-tls
```

`houston info --name ticket-1234` shows the cluster, the namespace and the arrangement. The
GUI's detail panel lists the pods, and why any of them cannot start.

---

## Removing it

```bash
houston down --name ticket-1234 --volumes     # the namespace and its data
houston prune                                 # also removes houston's own kind cluster, once it is empty
```

- `down` leaves the shared cluster running, because other workspaces use it.
- `houston prune` deletes the kind cluster **only if houston created it**, and only
  when no houston namespace is left. A cluster you brought is never deleted.
- `down --volumes` also removes the shared MongoDB operator and the shared monitoring
  stack once no other workspace needs them.
