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

## Sign in with Okta

People can open houston from their Okta tile, or the **Sign in with Okta** button, and
land on the dashboard without a houston password. Password sign-in stays: it is the way
in when Okta is down, and an Okta problem never stops `serve` or a password sign-in.

**In Okta**, the app is an OIDC web app with:

| Setting | Value |
|---|---|
| Sign-in redirect URI | `https://<houston host>/signin` |
| Initiate login URI | `https://<houston host>/signin`, login initiated by Either Okta or App |
| Grant type | Authorization Code |
| Client authentication | Client secret, sent as `client_secret_basic` |
| PKCE | required |
| Scopes | `openid profile email` |
| Assignments | the people who should see the tile |

A click on the tile opens `https://<houston host>/signin?iss=<issuer>`. houston starts
the sign-in when that issuer is exactly `sso.issuer`, and otherwise shows the sign-in page.
So set `sso.issuer` to what the tile sends, which is also the `issuer` in
`https://<Okta domain>/.well-known/openid-configuration`, with no trailing slash.

**On the host**, the issuer last, because setting it is what turns Okta on:

```bash
houston config set sso.client_id <client id>
houston config set sso.public_url https://houston.example.com
houston config set sso.email_domains example.com
houston config set sso.provision member          # off (the default), member or readonly
houston config set sso.issuer https://login.example.com
```

**The client secret** is the one value that is not a setting: it never goes in
`config.yaml`, which `config list` prints. Put it in `sso.env` in the houston home
(`~/.houston/sso.env`). houston refuses that file unless it is mode 0600, owned by the
user that runs `serve`, and holds exactly one line, `HOUSTON_SSO_CLIENT_SECRET=<secret>`,
unquoted. This writes it without the secret reaching a command line or your shell history:

```bash
( umask 077; read -rsp 'Okta client secret: ' s && echo &&
  printf 'HOUSTON_SSO_CLIENT_SECRET=%s\n' "$s" > "${HOUSTON_HOME:-$HOME/.houston}/sso.env" )
```

The environment variable `HOUSTON_SSO_CLIENT_SECRET` also works, and wins over the file.
A service printed by `--print-service` does not get your shell's variables, so for a
service use the file. A change takes effect without restarting `serve`, whose start-up
lines say whether Okta is on, or why not. `houston config unset sso.issuer` turns it off.

`sso.public_url` is where people open houston, and where Okta sends them back. Behind a
proxy that ends TLS, run `serve` with `--trust-proxy <its address>`, so houston knows the
browser is on HTTPS.

**To check it**, sign in once from the tile and once from the button with an account that
is not an admin's. `houston users` then shows `okta <email>` beside that account, and the
account chip shows the Okta username after the houston name. When something is refused,
the sign-in page says why; [Troubleshooting](troubleshooting.md#the-web-gui) lists each
reason.

Who signs in as whom:

- An Okta username `first.last` signs in as the houston account `first-last`, linked by
  Okta's own user id on first sign-in, so a later rename in Okta keeps the account.
- A `member` or `readonly` account of exactly that name links by itself. An `admin`
  account links only after `houston users link-sso <name>`.
- No such account: one is created with the `sso.provision` role (never admin), if the
  email is verified and in `sso.email_domains`, and the box already has an admin.
- A different name never links: houston `alice` and Okta `alice.smith` are two accounts.
  `houston chown` hands workspaces from one to the other.
- `houston users unlink-sso <name>` turns a link off and signs the account out; its
  password still works. `houston users remove` does the same and deletes the account.
  Either way, that Okta person cannot sign in again until `houston users link-sso <name>`.

Keep one admin with a password, not linked to Okta, as the way back in. Signing out of
houston does not sign you out of Okta. Run one `serve` per houston home, and back up
`users`, `sso-identities.json` and `sso.env` together.

## Finding your way

- **Top bar:** **Home**, **Activity** (running and past jobs), **Clusters**, **Scenarios**
  (presets), **Backups** (every backup on the machine, including those of deleted
  workspaces, each of which can be restored as a new workspace), **Refresh** (re-reads the
  page you are on), the light/dark switch (light is
  the default), and your account menu: **Your sessions**, **Change your houston password**,
  **Sign out**. The **doctor** chip on the left runs the environment check.
- **Home** shows what needs you, what is running and where, and how much memory is left.
- **The left rail** lists workspaces. Click one to open it: **Open RC**, **Stop**,
  **Restart**, and tabs for **Overview**, **Logs**, **Containers**, **Env vars** and
  **Backups**.
- **Its right-hand pane** has the rest: **Add sample data**, **Import settings**,
  **Send an API call**, **PAT and Token**, **Back up now**, **Upgrade version**,
  **Roll back to** the earlier version (after an upgrade that kept its backup),
  **Attach monitoring**, **Run a load test**, **Find capacity**, **Hand over…**, and
  **Take this workspace down**. Hand over, roll back and deleting the data are offered to
  the workspace's owner and admins, or to anyone under `gui.destroy_policy anyone`.

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
in front (`test` becomes `alice-test`), unless it names a workspace you may act on (yours,
or any for an admin): then it is that workspace.

For **e2ee**, choose the **Policy** and the switches; the [E2EE guide](e2ee.md) says
what each sets and how to try it.

## Sample data

**Add sample data** and the creation dialog show the same profile counts from the server:
small (5 users/12 rooms), standard (20/25) and large (100/60). Every profile includes
threads, other participants’ reactions, files, user profiles, group DMs and custom emoji.
Choose **Room states** or **Permissions** for the additional support scenarios.
Enable **Historical dates** to spread the batch over the preceding number of days
(default 180); leave it off for current dates. Each reopened dialog resets these choices.
The large-volume mode disables scenario/history controls. Results distinguish a complete
verification, a confirmed mismatch and an incomplete readback; only complete verification
is green. See [Sample data](guide.md#sample-data) for counts, recovery and history limits.

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
- A proxy must pass the port people typed in `Host` (nginx: `proxy_set_header Host $http_host;`):
  a request whose `Origin` names this host on another port is refused as another server's.
- `--trust-proxy <address or CIDR>` trusts that proxy's word that the connection was
  HTTPS. `0.0.0.0/0` means any address; a bare `0.0.0.0` means none.

## Keeping it running

```bash
houston serve --domain rc.example.com --email you@example.com --print-service
```

It prints a systemd unit, how to install it, and a `nohup` alternative, and changes
nothing. The unit carries the `PATH` of the shell you print it from, and `AWS_PROFILE`
and `AWS_REGION` when they are set, because systemd starts a service with none of them:
print it where `node`, `docker` and `aws` already work (under nvm, after `nvm use`).
