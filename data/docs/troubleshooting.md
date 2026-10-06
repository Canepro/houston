# Troubleshooting

Find the symptom, then the fix. **Start with `houston doctor`:** it checks the machine and
names most of what follows. On EKS, see [the EKS guide's list](eks.md#when-it-goes-wrong);
for what Kubernetes refuses, see [the Kubernetes guide](kubernetes.md#what-kubernetes-refuses).

**Contents:** [Installing](#installing) · [A workspace will not start](#a-workspace-will-not-start) ·
[Kubernetes](#kubernetes) · [HTTPS and certificates](#https-and-certificates) ·
[Left running](#left-running) · [The web GUI](#the-web-gui) ·
[Engines and images](#engines-and-images)

---

## Installing

| You see | Do this |
|---|---|
| `houston --version` prints someone else's version | Another npm package also installs `houston`. `command -v houston` shows which runs; uninstall the other or reorder your `PATH`. |
| An old houston still runs after installing 2.x | It was installed with pipx. See [Upgrading](upgrading.md#replacing-an-older-install). |
| Behind a proxy, `houston versions` uses the shipped list | Run `houston` (or `bin/houston`), not `node` directly: the launcher passes `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `REQUESTS_CA_BUNDLE` to Node. |

## A workspace will not start

`up` refuses before it builds anything, and the refusal names the fix:

| It says | Do this |
|---|---|
| something about **memory** | Remove a workspace you are done with: `houston down --name <name> --volumes`. |
| a **port** is in use | Pass `--port`, or leave it out and houston picks a free one. |
| the **Docker daemon** is not running | Start Docker Desktop, or `sudo systemctl start docker`. |
| "already exists and is reused as-is" | `up` brings back the existing workspace. `--force` rebuilds it, `--fresh` also wipes its data; `houston upgrade` changes the version. |
| a Docker Hub pull limit | Run `docker login`. |

It starts but Rocket.Chat never answers:

```bash
houston logs  --name <name> --tail 100
houston stats --name <name>          # a climbing restart count means it is out of memory
```

## Kubernetes

| You see | Do this |
|---|---|
| `up` worked but the URL does nothing | The port-forward died with its pod: `houston ready --name <name>` starts it again. "something else already holds it": `ss -ltnp \| grep <port>` names the program. |
| "no kubeconfig context named" | Add the cluster: `houston cluster connect <arn>` for EKS, or fix your kubeconfig. |
| kubectl works but helm says "cluster unreachable" | A stale kubeconfig. Regenerate it (k3s: `sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config`; kind: `kind export kubeconfig --name <cluster>`). |
| Every volume stays `Pending` | No default StorageClass: `houston cluster prepare --context <cluster>`. |
| A colleague gets "access denied" or `Unauthorized` | On a cluster houston built: `houston cluster share <cluster> --user <their-iam-user>`. Otherwise its owner adds an EKS access entry. |
| "no matching manifest for linux/arm64" | Rocket.Chat below 8.0.0 is amd64 only: use an amd64 node, 8.0.0 or newer, or Docker. |
| "no chart deploys it" or "predates every values key houston sets" | Rocket.Chat below 3.7.2: use Docker. |
| `env --set`, `seed --scale`, `loadtest` or `capacity` refuses | Docker only. The refusal names what to use instead. |

Names are lowercase: `TICKET-1234` lives in namespace `houston-ticket-1234`.

## HTTPS and certificates

| You see | Do this |
|---|---|
| "the ingress controller's built-in placeholder certificate" | Normal for a minute or three on a new cluster. `houston tls-status --name <name>` again; `kubectl -n houston-<name> get certificate` shows what it waits for. |
| Let's Encrypt never validates | The name must point at the right place, port 443 open, **before** `up`. On a cloud cluster, point it at the address `houston cluster prepare --context <cluster>` prints. On Cloudflare use **DNS only**. Check with `dig +short <name> @1.1.1.1`. |
| "something in front is terminating TLS for this name" | A proxy, CDN or another program is intercepting. `houston doctor` names a cluster holding the ports. |
| The browser warns about a local certificate | Run `houston trust-ca` once, then `houston tls-status --name <name>` says it is trusted. Phones cannot use local certificates: use `--domain`. |
| No "Local certificate" option in the GUI | The cluster is not on this machine; houston's CA key never leaves it. Use a domain. |

## Left running

A cloud cluster bills every hour it exists; only `houston cluster delete` stops it.

```bash
houston list               # workspaces on this machine
houston cluster overview   # clusters this machine knows: state, cost per day, expiry, next step
houston cluster list       # EKS clusters in every enabled AWS region
```

| You see | Do this |
|---|---|
| `cluster list` names regions it could not read | Those are not covered: check them with `aws eks list-clusters --region <region>`. |
| `doctor` has no local record of a cloud cluster | That is not "there is none": ask AWS with `houston cluster list`. |
| `cluster delete` refuses: it holds workspaces | Remove them first, see [Stop the bill](eks.md#stop-the-bill-delete-the-cluster). |
| A cluster deleted outside houston is still listed | `houston cluster forget <context>` removes its kubeconfig entry. |

## The web GUI

| You see | Do this |
|---|---|
| A cluster card says **Reading…** | It is being read. **Not read** or `?` means it could not be read, never zero. |
| The job log is quiet for a while | Long steps say "still installing (1m30s)". Over a couple of minutes, check **Activity** and `houston logs --name <name>`. |
| A control is missing | Options a runtime or cluster cannot honour are removed. Offline and "Don't pull images" are command-line only (`--offline`, `--no-pull`). |
| `serve` refuses to start on a reachable address | See [Reaching it from another machine](gui.md#reaching-it-from-another-machine), and create the first account before opening it up. |

## Engines and images

| You see | Do this |
|---|---|
| Slow on Apple Silicon | Rocket.Chat below 8 and MongoDB below 8 are amd64 only and run emulated. Everything newer runs natively. |
| Podman | Works through its Docker socket helper (`podman-mac-helper` on a Mac). |
| MongoDB 8 fails on Linux kernel 6.19 through 7.0.13 | [SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912): use an engine on kernel 7.0.14 or newer (on a Mac or Windows, update Docker Desktop), or a Rocket.Chat version paired with MongoDB 7.0. `houston doctor` warns; `docker info --format '{{.KernelVersion}}'` shows the kernel. |
