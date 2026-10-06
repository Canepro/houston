# The web GUI

`houston serve` puts a browser interface in front of houston, so a team can share one
machine: everyone signs in with a named account, and every action is recorded against it.

**Contents:** [Start it](#start-it) · [The first account](#the-first-account) ·
[Accounts and roles](#accounts-and-roles) · [Finding your way](#finding-your-way) ·
[Create a workspace](#create-a-workspace) · [Clusters and Amazon EKS](#clusters-and-amazon-eks) ·
[Policies and the audit log](#policies-and-the-audit-log) ·
[Reaching it from another machine](#reaching-it-from-another-machine) ·
[Keeping it running](#keeping-it-running)

---

## Start it

```bash
houston serve                  # http://localhost:7070/
houston serve --port 7171      # another port
```

It listens on `127.0.0.1` only. To open it to other machines, see
[Reaching it from another machine](#reaching-it-from-another-machine).

## The first account

With no accounts yet, `serve` prints a one-time link such as
`http://localhost:7070/setup#k=Xf9…`. Open the **whole** link, including the part after
`#`; it creates the first **admin** account.

- Each `serve` makes a new key, so an older link stops working.
- The link works only while `serve` listens on this machine alone: create the account
  first, then open it up.
- Or run `houston users add <name>` before `serve`, and you get a normal sign-in page.

## Accounts and roles

```bash
houston users                     # who exists, their roles and dates
houston users add alice           # prints a generated password once
houston users add alice --ask-password
houston users role alice admin    # admin, member or readonly
houston users passwd alice        # a new password; ends alice's sessions
houston users remove alice
```

| Role | May |
|---|---|
| `admin` | everything, including accounts and building or deleting clusters |
| `member` | everyday work: create, seed, load-test, tear down |
| `readonly` | look only. Cannot read logs or environment variables, which can hold secrets |

The first account is an admin; later ones are members. Admins can also manage accounts
in the GUI: your name, top right → **People & roles**. Roles apply to the GUI only:
anyone with a shell can run houston directly.

## Finding your way

- **Top bar:** **Home**, **Activity** (running and past jobs), **Clusters**, **Scenarios**
  (presets), **Refresh** (re-reads the page you are on), the light/dark switch (light is
  the default), and your account menu: **Your sessions**, **Change your password**,
  **Sign out**. The **doctor** chip on the left runs the environment check.
- **Home** shows what needs you, what is running and where, and how much memory is left.
- **The left rail** lists workspaces. Click one to open it: **Open RC**, **Stop**,
  **Restart**, and tabs for **Overview**, **Logs**, **Containers**, **Env vars** and
  **Backups**.
- **Its right-hand pane** has the rest: **Add sample data**, **Import settings**,
  **Send an API call**, **PAT and Token**, **Back up now**, **Upgrade version**,
  **Attach monitoring**, **Run a load test**, **Find capacity**, and
  **Take this workspace down**.

## Create a workspace

**+ New workspace** opens two steps:

1. **Where should it run?** **On this machine** (free): Docker, and any Kubernetes running
   here. **In AWS** (costs money): one card per Amazon EKS cluster, with its cost per day.
2. **Details:** the Rocket.Chat version and an optional name, the preset, sample data and
   monitoring, HTTPS, the shape, and **More options**. `--offline` and `--no-pull` are
   command-line only.

On an EKS cluster this server built with a DNS zone, HTTPS is Let's Encrypt: leave the
domain empty for `<name>.<zone>` and give a contact email once. Elsewhere, type a domain.

**Create workspace** shows the progress, then the address and the login. You can close
the dialog; the workspace keeps starting. With accounts, the name you type gets your name
in front (`test` becomes `alice-test`).

## Clusters and Amazon EKS

The **Clusters** page has a **This machine** card (Docker and local Kubernetes, with
**Create here**) and an **Amazon EKS** section: the AWS identity the server uses, then one
card per cluster with its state, cost per day and workspaces. Click a card for the
cluster's own page: **Create a workspace here**, **Public names (DNS)**, **Prepare again**,
**Delete cluster…** (admin, only on a cluster houston built, after typing its name).

**Set up Amazon EKS** (admin; later **+ Add a cluster**):

1. **Connect AWS on the server.** The GUI never asks for AWS keys: it uses whatever the AWS
   CLI finds on the machine running `serve`, and shows how to set that up (company SSO, a
   server role or keys in its environment), with **Re-check**.
2. **Choose a cluster.** **Build a new cluster** (approve the account, then name, region,
   nodes; about 20 minutes, billing from the start), or **Check for a cluster houston
   already built** and **Connect** it.
3. **Ready.** The DNS record for public names, and **Create a workspace** on it.

A cluster whose public names do not answer yet is listed on Home, and its card and page
offer **Set up DNS**: the record field by field, and a check that says whether it answers,
points elsewhere, or is proxied. A cluster's reminder date appears on Home once it is due.

The [EKS guide](eks.md) is the same in the terminal. Other kubeconfig contexts are used
from the CLI with `--context`; the GUI does not list them.

## Policies and the audit log

```bash
houston config set gui.create_policy admin      # only admins may set an image, a registration token, a bind address or a cluster
houston config set gui.destroy_policy anyone    # members may delete anyone's workspace
houston config set bind_host 0.0.0.0            # one decision for every new workspace
houston audit                                   # who did what
houston chown --name <workspace> --to bob       # hand a workspace to someone else
```

Under `gui.create_policy admin`, a member creates on Docker or the server's default
cluster only, and **Create here** appears only there. Every action is written to
`~/.houston/audit.log` with the account that took it. On the command line the account is
`HOUSTON_USER`, else your login name if an account has it; `houston audit` marks those
lines `asserted`.

## Reaching it from another machine

`serve` refuses to listen on a reachable address over plain HTTP unless you say what
protects it. Pick the row for where HTTPS ends:

| Where HTTPS ends | Command |
|---|---|
| nowhere: only you, on this machine | `houston serve` |
| houston handles it, on a name that points here | `houston serve --domain rc.example.com --email you@example.com` |
| a proxy on this machine | `houston serve --bind 127.0.0.1 --allow-host rc.example.com` |
| a proxy somewhere else (a lab, Codespaces, ngrok, a load balancer) | `houston serve --bind 0.0.0.0 --allow-host rc.example.com --trust-proxy 10.0.0.1` |

- `--allow-host` is the host people type; any other host gets a 403. Repeat it, or use `*`.
- `--trust-proxy <address or CIDR>` trusts that proxy's word that the connection was
  HTTPS. `0.0.0.0/0` means any address; a bare `0.0.0.0` means none.

## Keeping it running

```bash
houston serve --domain rc.example.com --email you@example.com --print-service
```

It prints a systemd unit, how to install it, and a `nohup` alternative, and changes
nothing.
