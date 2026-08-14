# rc-repro

**Reproduce a customer's Rocket.Chat issue on their *exact* version, in minutes.**
One command boots the right Rocket.Chat paired with a compatible MongoDB, plus
optional backing services (LDAP, SAML/OIDC, email, S3, multi-instance) and sample
data — instead of hand-building a compose stack for every ticket.

```bash
rc-repro up --version 8.5.1 --name TICKET-1234 --wait   # boot it
# → open the printed URL, log in as admin / admin123
rc-repro down --name TICKET-1234 --volumes              # bin it when done
```

Prefer a browser? [`rc-repro serve`](#web-gui) does all of the above.

## Contents

- [Getting started](#getting-started) — prerequisites, install, first repro
- [Everyday use](#everyday-use) — the lifecycle
- [Web GUI](#web-gui) — `serve`, accounts, and reaching it from somewhere else
- [Scenarios](#scenarios) — presets and monitoring
- [HTTPS](#https) — a real name, or a local certificate
- [Environment variables](#environment-variables) — settings vs. env vars
- [Data & performance](#data--performance) — seed, import, backup, upgrade, load test
- [API testing](#api-testing)
- [Reference](#reference) — commands, version resolution, state, development

Every command has `--help`, and it is written to be read — this file is the map,
`--help` is the detail.

---

# Getting started

## Prerequisites

- **Docker** with `docker compose` v2 — running.
- **Python 3.11+**
- Internet access, to pull images and look up version compatibility.

`rc-repro doctor` checks all of it and names anything that would fail a boot.

<details>
<summary><b>Apple Silicon, Podman, and Docker Hub rate limits</b></summary>

**Apple Silicon:** only the Bitnami MongoDB image (MongoDB < 8, i.e. RC < 8) is
amd64-only and runs emulated, so those boots are slower. Everything else is native.

**Podman** works via the `docker.sock` helper (`podman-mac-helper`). Two traps:

- **Kernel ≥ 6.19 cannot run MongoDB 8.0**
  ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). `doctor`
  warns when it sees this; use an engine on kernel < 6.19 until MongoDB ships a fix.
- **Docker Hub anonymous pull limits** (`registry.rocket.chat` counts against Hub
  too) — run `docker login`.

`up` names either cause directly rather than reporting a bare compose failure.
</details>

## Install

**Guided Ubuntu 24.04 amd64 setup** — on a clean host, these two auditable
commands install Docker Engine and Compose, pipx, kind, kubectl, Helm, and the
core rc-repro CLI from official signed or checksum-verified sources:

```bash
curl -fsSLO https://github.com/klovekesh37/rc-repro/releases/latest/download/rc-repro-install
bash rc-repro-install
```

The installer inventories the host before changing packages, refuses conflicting
Docker packages instead of removing them, runs `rc-repro doctor`, and creates no
cluster or repro. If Linux needs a new login for Docker-group or PATH membership,
the installer says so explicitly. In that new session, complete the interactive
human setup:

```bash
rc-repro onboard
```

The guided bootstrap is deliberately limited to native Ubuntu 24.04 amd64. It
stops without package changes on macOS, native Windows shells, WSL, other Linux
releases, and other architectures. On macOS, prepare Docker Desktop and the
Kubernetes tools separately. On Windows, prefer a Docker Desktop-backed WSL2
environment and manage its Linux tools separately; the Ubuntu installer refuses
WSL so it cannot install a second Docker Engine inside the distribution. These
platforms do not yet have the same newcomer acceptance proof.

**Core CLI only — with [pipx](https://pipx.pypa.io)** (isolated, adds `rc-repro`
to your PATH). Use this when the required container and Kubernetes tools are
already managed:

```bash
pipx install git+https://github.com/klovekesh37/rc-repro
```

**Alternative — a plain virtualenv:**

```bash
git clone https://github.com/klovekesh37/rc-repro.git && cd rc-repro
python3 -m venv .venv && source .venv/bin/activate
python -m pip install --upgrade pip     # editable installs need pip >= 21.3
pip install -e .
```

For a core-only or virtualenv installation, confirm your separately managed
prerequisites are ready. `doctor` checks Docker, Compose, disk, connectivity and
ports; fix any ✗ before continuing:

```bash
pipx install 'rc-repro[gui] @ git+https://github.com/klovekesh37/rc-repro'
rc-repro doctor
```

The `gui` extra adds the few dependencies [`serve`](#web-gui) needs; drop it for a
CLI-only install. In a checkout: `pip install -e '.[gui]'`.

To update: `pipx reinstall rc-repro` (`upgrade` only moves when the version was
bumped). In a checkout: `git pull && pip install -e '.[gui]'`.

`rc-repro --version` reports what is **installed**, which is the number the running
code actually is. In a checkout that comes from the distribution metadata, not from
`pyproject.toml`, so `git pull` alone does not move it — re-run `pip install -e .`
or the version will keep naming the release you had before. On a remote box that
one command is how you tell whether a deploy actually landed.

## Your first repro

```bash
rc-repro up --version 8.5.1 --name test --wait
# open the printed URL — admin / admin123
rc-repro down --name test --volumes
```

- `--wait` blocks until Rocket.Chat answers and skips the setup wizard. First boot
  pulls images and can take a few minutes.
- `--name` is optional (derived from the version) — use a **ticket id** so `list`
  maps repros to your work.
- Every repro creates the same admin: **`admin` / `admin123`**.

> **Local by default.** Published ports bind `127.0.0.1`. `--bind 0.0.0.0` exposes Rocket.Chat **and every sidecar**
> (Keycloak, Mailpit, MinIO — all with known credentials) to your whole network.
> This is a reproduction tool, never a deployment.

---

# Everyday use

```bash
rc-repro list                     # version, port, state, URL
rc-repro info   --name test       # URL, credentials, snippets, preset notes
rc-repro logs   --name test -f    # tail
rc-repro ready  --name test       # block until serving
```

A repro is long-lived — pause and resume it rather than recreating it:

| Command | Effect |
|---|---|
| `up` | create, or bring an existing one back up (data intact) |
| `stop` / `start` | pause / resume — containers kept, seconds |
| `down` | remove containers, **keep** data and the record |
| `down --volumes` | delete the data and forget it (confirms first) |
| `prune` | remove every `down` repro (skips pinned and running; confirms first) |

Both data-deleting commands prompt, and `prune` lists what it will delete. `--yes`
skips the prompt in scripts.

**A daily driver:** `rc-repro up -v 8.5.1 --name main --pin` once, then `rc-repro
start` / `rc-repro stop`. Commands with no `--name` act on the pinned repro (or
whatever `rc-repro use <name>` last set).

---

# Web GUI

`rc-repro serve` is the same engine as the CLI with a browser in front — useful
when you would rather click than type, and the way a team shares one box.

## On your own machine

```bash
rc-repro serve                    # http://localhost:7070/
```

It binds **loopback only** — the GUI can create and delete
containers and their volumes and mint admin tokens, so the port is docker control.
Binding anything else needs a deliberate flag, and rc-repro refuses the unsafe
combinations rather than warning about them.

**The first account.** With no accounts, a loopback `serve` prints a one-time link:

```
http://localhost:7070/setup#k=Xf9…
```

Open the **whole** URL including the part after `#`. A fragment never reaches the
server, so the key cannot appear in an access log, a proxy log or a `Referer`
header. The page asks for a name and a password and creates the first **admin**.

Prefer the terminal? `rc-repro users add <name>` first, and `serve` shows a normal
sign-in page instead.

## Accounts

```bash
rc-repro users                    # who exists, their roles and dates — never hashes
rc-repro users add alice          # GENERATES the password and prints it once
rc-repro users add alice --ask-password
rc-repro users role alice admin   # admin | member | readonly
rc-repro users passwd alice       # new password, ends alice's sessions
rc-repro users remove alice       # and every session it minted
```

The **first** account is an admin; every one after it is a `member` until you say otherwise.

A name is **folded into a DNS label**, because it becomes part of a workspace name
— `lucy.felix` and `Lucy_Felix` both create `lucy-felix`, and `users add` prints
what it made. Sign-in, `passwd`, `role` and `remove` all accept either spelling, so
the name somebody was given is the one they can type. A name with nothing usable
left in it (`...`) or one over 31 characters is refused rather than invented or
truncated.

The password is generated rather than typed unless --ask-password; and a generated one is ~96 bits where a typed one clears a
12-character minimum with scrypt.
Stored in `~/.rc-repro/users`, mode `0600`, hashed with `hashlib.scrypt`.

**Three roles, not a permission system:**

| Role | May |
|---|---|
| `admin` | everything, including managing people |
| `member` | everyday use — create, seed, load-test, tear down |
| `readonly` | look, but not touch — and **not** read logs or env vars, which carry LDAP bind passwords and OAuth client secrets |

A `member` may set `--rc-image`, `--reg-token` and `--bind`:

```bash
rc-repro config set gui.create_policy admin      # only admins may set those three
rc-repro config set gui.destroy_policy anyone    # members may delete anyone's workspace
rc-repro config set bind_host 0.0.0.0            # one decision instead of per-create
```

Sessions are server-side and revocable: sign-out ends one, changing or removing an
account ends every session it minted, and each person can see their own from the
account menu. 

## Reaching it from somewhere else

Signing in over plain http puts the password on the wire once and the session
cookie on every request after it. `serve` therefore **refuses** to bind a
reachable interface over plain http unless you say what is protecting it. Pick the
row that matches where TLS actually ends:

| Where TLS ends | Command |
|---|---|
| Nowhere — just you, on this machine | `rc-repro serve` (add `--no-domain` if this box was set up with `--domain`, or it keeps serving that name) |
| rc-repro does it, on a name that points here | `rc-repro serve --domain rc.example.com --email you@example.com` |
| A TLS proxy on **this** box | `rc-repro serve --bind 127.0.0.1 --allow-host rc.example.com` |
| A proxy **elsewhere** — a lab, Codespaces, ngrok, a load balancer | `rc-repro serve --bind 0.0.0.0 --allow-host rc.example.com --trust-proxy 10.0.0.1` |
| Nothing, and you accept it | `rc-repro serve --bind 0.0.0.0 --allow-host <name> --insecure` |

`--insecure` is deliberately **not** listed in `serve --help`: it is a security
decision that does not apply on localhost or behind a lab's TLS, which is where
almost everyone starts. It still works, and `serve` names it — with the exact
command to add it to — at the one moment it applies, which is when it refuses to
put a password on the wire by accident.

Two flags do the work, and they answer different questions:

- **`--allow-host`** is a **DNS-rebinding guard**: whatever you type in the address
  bar has to be named here, or the request is a 403. Repeatable; `*` accepts any
  host. This is the one people miss when a proxy forwards its own `Host` and every request 403s.
  It wants a **bare hostname** — a scheme, a port or a trailing slash is corrected
  and reported (`--allow-host https://lab.example.com:9944/` becomes
  `lab.example.com`), because the guard matches the `Host` header with its port
  already stripped. Omit it on a reachable bind and only `localhost` is accepted;
  `serve` says so at startup, and the 403 names the host it refused.
- **`--trust-proxy <address-or-CIDR>`** says *this peer terminates TLS, believe its
  `X-Forwarded-Proto`/`-For`*. Without it rc-repro cannot tell the browser's hop is
  https, so it will not mark the session cookie `Secure` and the sign-in page warns
  about a connection that is actually encrypted. It grants *permission to believe*
  that header — the cookie becomes `Secure` only once a peer inside the given range
  actually sends it, which is why the startup line reads "https **when the proxy
  says so**". `0.0.0.0/0` believes any client, so anyone can then claim https and
  dodge the sign-in throttle; `serve` warns about it.
  > **A bare `0.0.0.0` is not "anywhere" — it is the single address `0.0.0.0/32`,
  > which no peer ever has.** It parses, so nothing used to complain, and the flag
  > then did exactly nothing while looking correct. Write `0.0.0.0/0` for anywhere,
  > or better, the proxy's actual address. `serve` now says so at startup.

> Run `rc-repro users add <name>` first. The one-time setup link is offered on a loopback bind only.


Everything the GUI does is a CLI command underneath, and every action is recorded
against the account that took it and appended to `~/.rc-repro/audit.log` — a file. Read it with `rc-repro audit`.

## Your own workspaces

With accounts, derived names are namespaced by owner, so two people can run the
same version:

```
$ rc-repro list
NAME                 OWNER        RC        MONGO   PORT   STATE      URL
*alice-rc8-5-1       alice        8.5.1     8.0     3000   running    …
 bob-rc8-5-1         bob          8.5.1     8.0     3001   running    …
```

## Keeping it running

```bash
rc-repro serve --domain rc.example.com --email you@example.com --print-service
```

Prints a **systemd unit** and how to install it, plus a `nohup` fallback — and
writes nothing, so you can read it first. systemd restarts on crash, starts on
boot, and gives you `journalctl -u rc-repro -f`. `nohup` survives logout and
nothing else.

---

# Scenarios

A preset turns a bare Rocket.Chat into a scenario. `rc-repro presets` lists them;
the GUI's **Scenarios** page shows the same thing with each one's setup steps.

```bash
rc-repro up --version 8.5.1 --preset ldap
```

For a reusable scenario with a different deployment, use the independent
selectors. `--scenario` may be repeated, but the currently proven matrix admits
only one scenario at a time; unsupported pairs fail before Docker, Kind, Helm, or
workspace creation:

```bash
rc-repro up --version 8.6.1 \
  --deployment microservices \
  --scenario ldap --set users=5 \
  --seed --seed-profile small --wait
```

`--deployment` accepts `default`, `multi-instance`, or `microservices` (the
`--topology` spelling is an alias). Existing `--preset` commands remain valid:
`--preset ldap` means the default Compose deployment plus LDAP, while
`--preset microservices` means Kubernetes with no scenario. A scenario preset can
be paired with an explicit deployment (`--preset ldap --deployment microservices`)
as the compatibility form of the command above.

| Preset | Brings up | Reproduces |
|---|---|---|
| `default` | RC + Mongo | anything |
| `airgapped` | Cloud endpoints stubbed out | offline / disconnected workspace |
| `ldap` | OpenLDAP with users and a group | LDAP auth and sync |
| `saml` | a real Keycloak IdP (SAML realm) | SAML SSO |
| `oidc` | a real Keycloak IdP (OpenID Connect) | OIDC / OAuth SSO |
| `email` | Mailpit wired to RC's SMTP | invites, resets, verification, 2FA codes |
| `s3_minio` | MinIO as the upload backend | uploads, previews, presigned URLs |
| `livechat` | Omnichannel, an available agent, a demo site embedding the widget | widget load, CORS, routing, agent availability |
| `multi-instance` | N instances + load balancer + NATS, one Mongo | scaling, cross-instance real-time |

For `ldap`, `saml` and `oidc`, log in as **`user1` / `user1`**.

```bash
rc-repro up -v 8.5.1 --preset ldap --set users=130000        # scale repro
rc-repro up -v 8.5.1 --preset multi-instance --set instances=3
rc-repro up -v 8.5.1 --preset email --seed --wait            # verified users + Mailpit
rc-repro up -v 8.5.1 --preset s3_minio --set presigned=true  # real presigned URLs
rc-repro up -v 8.5.1 --preset livechat --wait
```

**`oidc` needs one host entry** — `127.0.0.1  keycloak` in `/etc/hosts`, because the
login URL must resolve the same way for your browser and RC's backend. `up` prints
it, `rc-repro info` reprints it, and the GUI shows it as a blocking setup step.
Everything else a preset needs is in its notes: consoles, credentials, realms.

<details>
<summary><b>Custom presets and Enterprise licences</b></summary>

Drop a YAML file in `~/.rc-repro/presets/<name>.yaml` (it overrides a built-in of
the same name). **Treat preset files as code** — they can run arbitrary containers
and mount files.

```yaml
name: my-scenario
description: What this reproduces.
env:
  OVERWRITE_SETTING_Some_Setting: "true"
services:
  my-sidecar: { image: some/image:tag }
depends_on: [my-sidecar]
```

For an EE licence pass a cloud **registration token** — the workspace
self-registers on first boot and Rocket.Chat Cloud syncs the licence down:

```bash
rc-repro up -v 8.5.1 --reg-token <token> --wait
```

Put `reg_token:` in `~/.rc-repro/config.yaml` or export `RC_REPRO_REG_TOKEN` to
stop retyping it.
</details>

## Monitoring

Prometheus + Grafana + Loki on top of *any* repro — an add-on, not a preset, so it
layers onto whatever you chose:

```bash
rc-repro up -v 8.5.1 --monitor
rc-repro monitor --name test           # or attach later, without restarting RC
rc-repro monitor --name test --off
```

**Grafana** on `http://localhost:5050` (`admin`/`admin`, anonymous view on) with the
official *Rocket.Chat Metrics*, MongoDB and Node Exporter dashboards provisioned;
**Prometheus** on `:9090`; container logs shipped to **Loki** and readable in the
*Rocket.Chat Logs* dashboard. The log collector is scoped to this repro's compose
project, so it never ingests your others.

---

# HTTPS

**A workspace never terminates TLS.** One Traefik — the **edge** — holds `:80` and
`:443` and serves every name on the machine. It starts by itself with the first
workspace that needs one.

```bash
# A domain name, with a Let's Encrypt certificate
rc-repro up -v 8.5.1 --domain t1234.example.com --email you@example.com

# No domain, no internet: rc-repro's own CA
rc-repro trust-ca                       # once
rc-repro up -v 8.5.1 --https            # https://<name>.rcrepro.localhost
```

The email is remembered (`rc-repro config set acme.email …`). Rocket.Chat's
`ROOT_URL` becomes the https URL, which is what makes OAuth/SAML redirects.

**shared fate is real**: while the edge is down, every https name on the box is
unreachable, which is why `doctor` calls a stopped edge a failure rather than a
warning.

```bash
rc-repro edge status     # running? which names? can it reach each one?
rc-repro edge stop       # frees :80 and :443
```

`status` prints each route beside whether the edge is actually attached to that
workspace — a route it cannot reach answers **502** rather than erroring, and
nothing else would tell you.

<details>
<summary><b>dns-01 — the way round all of that, and what unlocks a wildcard</b></summary>

Not a flag. Put your provider's credentials in `~/.rc-repro/acme/dns.env` and
rc-repro uses dns-01 automatically:

```bash
mkdir -p ~/.rc-repro/acme && chmod 700 ~/.rc-repro/acme
printf 'CF_DNS_API_TOKEN=%s\n' "$TOKEN" > ~/.rc-repro/acme/dns.env
chmod 600 ~/.rc-repro/acme/dns.env
```

---

# Environment variables

```bash
rc-repro env                                        # the effective env, secrets masked
rc-repro env --setting Message_AllowEditing=false   # a Rocket.Chat SETTING
rc-repro env --set MY_FLAG=true                     # a raw env var
rc-repro env --unset ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS
```

Most Rocket.Chat configuration is a **setting** (what you would change in the admin
UI), not a plain env var — and a setting only takes effect from the environment
with the `OVERWRITE_SETTING_` prefix. The bare form failing *quietly* is the trap:

| Env var | Effect on `Accounts_ShowFormLogin` |
|---|---|
| `Accounts_ShowFormLogin=false` | **none** — accepted by docker, silently ignored |
| `OVERWRITE_SETTING_Accounts_ShowFormLogin=false` | applied |

So **`--setting Id=value` adds the prefix for you** — prefer it for anything you
would change in Admin → Settings. `--set` is for real env vars. If you use `--set`
with a name that *is* a setting on this workspace, rc-repro says so and gives you
the prefixed form; it asks the workspace, so it is right for whatever version is
running. The GUI's Env-vars tab does the same and keeps the two kinds apart.

`OVERWRITE_SETTING_*` is **asserted at every boot, not locked** — the API and admin
UI can still change it while the container runs, and the next restart puts the env
value back.

Applying a change rewrites the compose file and recreates **only** the Rocket.Chat
container: MongoDB keeps running, its volume is untouched, no image is pulled, open
sessions reconnect. `--no-restart` writes it for the next `up`.

Overrides persist in the repro's metadata, so `up --force` keeps them. Precedence is
base → preset → yours. Load-bearing keys (`MONGO_URL`, `PORT`, `ROOT_URL`,
`TRANSPORTER`) are allowed — reproducing a broken configuration is the point — but
each prints what it will break.

---

# Data & performance

## Sample data

A fresh repro is empty. `--seed` creates realistic users, channels, DMs and
messages, authored across the users rather than all by admin:

```bash
rc-repro up -v 8.5.1 --name test --seed --seed-profile standard
rc-repro seed --name test --profile large
rc-repro seed --name test --users 30 --channels 10 --messages 40
```

| Profile | Users | Channels | Msgs/channel | DMs | Threads & reactions |
|---|---|---|---|---|---|
| `small` (default) | 5 | 3 | 5 | 2 | no |
| `standard` | 20 | 8 | 20 | 5 | yes |
| `large` | 100 | 20 | 100 | 20 | yes |

Seed users are `alice`, `bob`, … with password = username. Email-2FA and the rate
limiter are disabled while seeding and **restored afterwards**.

**Scale repros** ("50k users", "a room with 800k messages won't load") want
`--scale`, which bulk-inserts straight into MongoDB at tens of thousands per second:

```bash
rc-repro seed --name test --scale users=50000,messages=800000@general
rc-repro seed --name test --clear-scale        # removes exactly what --scale added
```

Bulk documents bypass RC's hooks: bulk users are **credential-less** and messages
fire no notifications or threading. Use `--scale` for scale behaviour and the REST
seed for feature behaviour.

## support dump configuration

```bash
rc-repro config-import ./support-dump/8.5.0-settings.json --name test --dry-run
rc-repro config-import ./8.5.0-settings.json --name test --only Livechat,LDAP
```

Applies the settings from the suport dump. Deliberately skips **redacted
secrets** (listing them so you can set them by hand) and **identity settings** that
would break or pollute a local repro (`Site_Url`, `Enterprise_License`, `Assets_*`,
cloud registration).

## Backup, restore, upgrade

```bash
rc-repro backup --label "before upgrade"    # → ~/.rc-repro/backups/*.rcbak
rc-repro restore <bundle> --new             # rebuild a whole workspace from it
rc-repro upgrade --to 8.6.1                 # backs up first; --rollback undoes it
```

A backup is a **bundle**, not a bare dump: the database plus the version, preset and
parameters that produced it — which is what lets one file rebuild a workspace on a
colleague's machine. Rocket.Chat is stopped for both operations (`mongodump` is not
point-in-time consistent across collections; `--live` skips it) and the target
database is dropped first, so you never end up with a hybrid. Restoring newer data
into an older workspace is refused; older into newer needs `--allow-upgrade`.

**Not included:** sidecar data — MinIO objects, Keycloak realms, LDAP entries,
Mailpit mail.

`upgrade` needs the repro **running**, because the migrations happen when RC boots.
An upgrade that also needs a new MongoDB *major* is refused rather than attempted —
majors have to be stepped one at a time with a `featureCompatibilityVersion` bump
between each, and doing it in one move is how data is lost.

## Load testing and capacity

```bash
rc-repro loadtest --name test --scenario journey --vus 50 --duration 60s
rc-repro loadtest --name test --scenario custom --endpoint "GET /api/v1/channels.list?count=100"
rc-repro loadtest --name test --scenario journey --save before-fix
rc-repro loadtest --name test --scenario journey --compare before-fix
rc-repro capacity --name test --slo "p95=300ms,error=2%"
rc-repro benchmark --versions 8.4.1,8.5.1,8.6.0 --report
```

Real concurrent load through [k6](https://k6.io), run as a throwaway container on
the repro's own network, so it works with loopback-only binds.

- **Scenarios:** `journey` (a full session per iteration, each step timed so you see
  *which* one is slow), `messages`, `login`, `read`, `mixed`, `webhook`, `badbot`,
  and `custom` — any endpoint you name.
- **Shapes:** constant `--vus`, `--ramp 10:200`, or `--spike 10:100`, which reports
  how long p95 took to recover after load dropped. Long runs with `--stats` report
  the RAM slope per hour — the soak-test leak signal.
- **Their hardware:** `--constrain "rc=2cpu/2g,mongo=1cpu/1g"` caps services for the
  run (live, no restart, restored after).
- **`--slo p95=300ms,error=1%`** exits non-zero, so it drops into CI.
- **Diagnosis, on by default:** RC's event-loop lag, MongoDB's slow queries with
  their plans (flagging **COLLSCAN**), and a p95 timeline pinning *when* errors
  started — ending in a plain-language verdict.

`capacity` doubles VUs until the SLO breaks, bisects the boundary, and says why it
broke. `benchmark` boots several versions, runs the identical workload against each
and prints the deltas — the regression check that only a version-matched tool can do.

> **VUs are k6 workers, not Rocket.Chat accounts.** Write scenarios leave real
> messages in `#general`; `read` and `login` add nothing.

---

# API testing

```bash
rc-repro token --name test                     # -H auth headers
rc-repro api   --name test GET /api/v1/me
rc-repro api   --name test --pat POST /api/v1/users.update -d '{"userId":"ID","data":{"name":"X"}}'
rc-repro api   --name test --2fa POST /api/v1/settings/<id> -d '{"value":true}'
```

`--pat` mirrors a customer's Personal Access Token (with "Ignore 2FA"); `--2fa` gets
past a 2FA-guarded admin endpoint. The GUI has the same thing as a console, with the
response pretty-printed.

---

# Reference

## Commands

| Command | Purpose |
|---|---|
| `up` | create and start a version-matched repro |
| `start` / `stop` / `restart` / `down` | lifecycle; `down --volumes` also deletes data |
| `list` / `info` / `logs` / `ready` | what exists, where it is, what it is doing |
| `use` / `config` | the default repro; remembered settings |
| `env` | show or change env vars, recreating RC to apply |
| `seed` | sample users/channels/messages; `--scale` for bulk Mongo prefill |
| `config-import` | apply a customer's exported settings |
| `backup` / `backups` / `restore` | bundle a repro's database, list bundles, load one back |
| `upgrade` | move a running repro to another version; `--rollback` |
| `stats` / `benchmark` / `loadtest` / `capacity` | measure it |
| `monitor` | attach/detach Prometheus + Grafana |
| `token` / `api` / `pat` | REST auth and calls |
| `presets` / `versions` | what scenarios exist; the resolved MongoDB pairing |
| `serve` / `users` / `audit` | the [web GUI](#web-gui), its accounts, and who did what |
| `chown` | hand a workspace over to somebody else, with the record to match |
| `edge` / `trust-ca` / `tls-status` | the shared Traefik, the local CA, what is really served |
| `doctor` | preflight: Docker, Compose, kernel, Hub auth, disk, memory, ports |
| `prune` | delete every `down` repro |

`rc-repro <command> --help` for flags.

## Exit codes

A **domain** failure exits with a code that says which kind it was, so a script
can tell "still coming up" from "fix your environment" without parsing the
message.

| Code | Meaning | Do about it |
|---|---|---|
| 0 | success | — |
| 2 | usage / validation | fix the call — retrying unchanged will not help |
| 3 | engine unavailable | Docker is not answering (`rc-repro doctor`) |
| 4 | not found | no such repro |
| 5 | not ready | **poll again** — it is still coming up |
| 8 | conflict | the name or port is taken; pick another |
| 1 | anything else | including argument errors the CLI catches before a command runs |

**1 is still the common answer**, deliberately: only failures raised by the
service layer as a typed error carry a code today. A mistyped flag, a missing
file, an out-of-range `--vus` and similar are caught in the command itself and
still exit 1. Branch on `$? -ne 0` for "did it fail", and on the table above only
where you have checked the specific command returns what you expect.

`rc_repro.errors.EXIT_CODES` also reserves **6** (authority gate) and **7**
(create failed). Nothing raises them yet — they arrive with the work that needs
them, and are listed here so the numbers are not reused for something else.

> **Changed in 0.44.0.** Domain failures used to exit `1` like everything else. A
> script testing `$? -eq 1` should test `$? -ne 0` instead.

`rc-repro evidence --name <name> --json` is the support-tool handoff. It omits
admin credentials and free-form preset metadata, reduces the root URL to its
origin, records created container image IDs when Docker is available, and is
safe to redirect into an evidence folder. Review the output before sharing it
outside the support workflow.

`up`, `ready`, `down`, `list`, `info`, `inspect`, `evidence`, `doctor` and `capabilities`
accept `--json` for scripts and agents (see [Agent & JSON interface](#agent--json-interface)).

## Capturing a reproduction

`evidence` proves what was deployed. It does not prove *do X, then Y goes wrong*,
which is the shape of nearly every escalation. `capture` drives a scripted
reproduction through a real browser and writes the whole attachable bundle in one
command:

```bash
pip install 'rc-repro[capture]' && playwright install chromium

rc-repro workloads                                      # list workloads
rc-repro capture --name my-repro --workload smoke       # run one
```

The bundle contains a screenshot per named checkpoint, a video of the run, a
Playwright trace (`npx playwright show-trace capture/trace.zip`), the evidence
record, and a `README.md` linking them together. That README is the file you
attach; the JSON stays authoritative for scripts.

Write a workload for your own reproduction by copying the built-in `smoke` into
`~/.rc-repro/workloads/<name>.yaml`. A user file overrides a built-in of the same
name, which is also how you repair a shipped workload after a UI change:

```yaml
name: my-repro
description: What this demonstrates.
steps:
  - goto: "/"
  - wait_for: "input[name=usernameOrEmail]"
    timeout_ms: 60000
  - shot: landing
  - fill: "input[name=usernameOrEmail]"
    value: "{{admin_user}}"
  - fill: "input[name=password]"
    value: "{{admin_pass}}"
  - click: "button[type=submit]"
  - shot: signed-in
```

Two things worth knowing:

**A capture that cannot finish fails (exit 9).** rc-repro runs version-matched
repros and Rocket.Chat's selectors move between versions, so a workload authored
against one version may find nothing on another. Rather than shooting a blank page
that still looks like evidence, the run stops and the manifest names the step that
could not run.

**A rerun will not quietly replace a bundle.** If the target directory already
holds one, `capture` stops with exit 8 before starting the browser. A bundle is
evidence and its README usually carries observed behaviour written by hand, so
replacing it takes an explicit `--force`.

**Credentials go in as `{{placeholders}}`.** They are substituted for the browser
but recorded unresolved, so the manifest describes what happened without carrying a
secret. A literal typed into a password field is redacted, and the Playwright trace
is scrubbed before it is written, because Playwright records every action's
arguments verbatim.

## Kubernetes microservices preset

Docker Compose stays rc-repro's default. The `microservices` preset is an opt-in
Kubernetes topology that runs Rocket.Chat's microservices from the official Helm
chart on a local `kind` cluster, with the same create, readiness, inspect, evidence
and teardown lifecycle as every other repro:

```bash
rc-repro onboard                            # interactive, once per machine
rc-repro up --preset microservices --version 8.6.1 --name first-repro --wait
rc-repro info --name first-repro            # URL, pods, port-forward state
rc-repro inspect --name first-repro         # cluster, nodes, pods, and services
rc-repro evidence --name first-repro --json
# Open the URL reported by `info`, then reproduce the behaviour.
rc-repro down --name first-repro --volumes --yes
rc-repro prune --yes                        # optional: reclaim the empty shared cluster
```

`info` is the quick human handoff: it shows the URL, runtime state, pods, and
port-forward. `inspect` is the read-only deep view: it adds the shared Kind
cluster, owned context and namespace, node health, and namespace Services. Its
JSON form uses rc-repro's isolated kubeconfig and intentionally excludes admin
credentials, registration tokens, and Kubernetes Secret contents, so it can be
pasted into a case without a hand-written `jq` projection.

The first VPS acceptance run and its remaining seed defects are recorded in
[`ACCEPTANCE-K8S-SEED-2026-08-05.md`](ACCEPTANCE-K8S-SEED-2026-08-05.md).

Needs `kind`, `kubectl` and `helm` on `PATH`. rc-repro owns one local cluster
(`rc-repro-local`) with a namespace per repro, so several microservices repros
coexist. Its kubeconfig and all Helm client state live under
`RC_REPRO_HOME/clients`; ambient `~/.kube` and Helm XDG directories are never read
or written. Repository setup, chart lookup and chart installation fail with the
structured `CREATE_FAILED` error instead of continuing with an unpinned chart.
MongoDB is always external (a single-node replica set from the official
image, since the chart's bundled MongoDB is amd64-only and its default tag predates
what recent Rocket.Chat requires). Reachability is a `kubectl port-forward`, so
`root_url` behaves exactly as on Docker.

Per-repro `down` deliberately keeps the shared cluster warm for later runs. `prune`
deletes it only after proving that no rc-repro-owned namespace remains; an
unreachable cluster or failed ownership query is retained rather than guessed safe.

Measured floor: **6 GiB memory and 4 CPUs** (8 recommended); CPU is the binding
constraint during start-up. `rc-repro doctor` reports whether the toolchain and the
floor are met. Rocket.Chat 8.2+ requires MongoDB 8.0, which cannot start on an engine
kernel 6.19 or newer ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912));
on such a host use a 7.x line, and rc-repro refuses the impossible combination up
front rather than timing out. Microservices are an enterprise feature: an unlicensed
repro comes up but may not function as licensed, so rc-repro warns and records the
licence state in evidence (pass `--reg-token`, `RC_REPRO_REG_TOKEN`, or owner-only
`config.yaml` `reg_token` to supply a Cloud registration token; the Kubernetes path
delivers it through a Secret, never through values.yaml).

### Remote access over SSH

Repros bind to **loopback only** by default. That is intentional: admin credentials
are fixed and weak. A local session opens the URL from `info` directly. From an SSH
session, open a tunnel on your machine instead of trying to browse the remote host's
`localhost`:

```bash
# On the remote host (after create + ready)
rc-repro up --preset microservices --version 8.6.1 --name first-repro --wait --json
# The result's data.access field includes tunnel_command and browser_url when SSH_* is set.

# On your laptop (example; use the exact tunnel_command from the result)
ssh -N -L 3000:127.0.0.1:3000 you@remote-host
# Then open http://127.0.0.1:3000 in a local browser.
rc-repro down --name first-repro --volumes --yes
```

rc-repro never changes the bind address, opens a firewall, or creates public ingress
for this handoff. Override the suggested host/user with `RC_REPRO_SSH_HOST` and
`RC_REPRO_SSH_USER` if the defaults are wrong. If the suggested port is already in
use on your laptop, set `RC_REPRO_SSH_LOCAL_PORT` on the remote command before
running `up` or `info` again; the returned command and browser URL will use that
client-side port while preserving the repro's remote port.

## Agent & JSON interface

rc-repro exposes a stable machine-readable surface so scripts and agents drive it
without scraping human output or importing internals.

- **Discovery.** `rc-repro capabilities` returns, as JSON, the contract version, every
  command with its schema and flags, the progress phases, the error and exit codes,
  the presets and the topologies. It answers offline, before you know the environment
  works. `rc-repro doctor --json` is the preflight call and exits `3` on any failure.
- **One envelope.** Every `--json` reply is `{schema, contract, ok, data, warnings,
  error}`, so success, data and errors are always in the same place. Long-running
  verbs (`up`, `ready`, `down`) stream NDJSON progress events, then one final envelope.
- **Exit codes**, so a caller can tell states apart without parsing prose: `0` ok,
  `2` usage, `3` preflight, `4` not found, `5` not ready (may poll), `6` a human
  authority gate (stop and ask), `7` create failed (known dead, stop), `8` conflict.
  Each error also carries a stable `code`.
- **Authority.** One-time interactive `onboard` persists permission to create and
  later delete the owned local cluster and, only when relevant, to resize the
  container engine. An un-onboarded agent hitting the Kubernetes path gets exit `6`
  with the exact command to ask a human to run, rather than inventing a baseline.
  Automation may use `--accept-defaults`, but must supply every authority it needs
  explicitly with repeatable `--grant` flags.
- **The skill.** `rc-repro skill install` drops the versioned agent skill into an
  agent host, so the skill always matches the rc-repro you are running.

## How version → MongoDB resolution works

`rc-repro up --version X` (and `rc-repro versions X`) queries
`releases.rocket.chat/<version>/info` — Rocket.Chat's own per-release compatibility
data — and picks the highest supported MongoDB. Offline, or for a release predating
that data, it falls back to the shipped `versions.yaml` (`--offline` forces this).

The image follows the resolved Mongo version: **≥ 8** →
`mongodb/mongodb-community-server` with a fix-permission and one-shot init container
(matching the official compose); **< 8** → `bitnamilegacy/mongodb`.
`MONGO_OPLOG_URL` is emitted only for RC < 8.

## Where state lives

```
~/.rc-repro/                  # override with RC_REPRO_HOME
├── config.yaml               # default repro, reg_token, bind_host, gui policies
├── users                     # GUI accounts — 0600, scrypt
├── sessions                  # server-side sessions — 0600
├── audit.log                 # who ran what
├── presets/                  # your custom presets
├── backups/  reports/  loadtests/
├── acme/                     # ACME state; dns.env, issued.json
├── edge/                     # the shared edge and one file per route
└── repros/<name>/
    ├── docker-compose.yml    # generated — re-run `up` rather than editing
    └── repro.json
```

Config can also come from the environment, which wins over `config.yaml`:
`RC_REPRO_HOME`, `RC_REPRO_REG_TOKEN`, `RC_REPRO_RC_IMAGE`, `RC_REPRO_BIND_HOST`
(the `--bind` flag wins over both).

Selector defaults are additive and optional. They are used only when `up` receives
no `--preset`, `--deployment`, or `--scenario`:

```yaml
default_deployment: microservices
default_scenarios:
  - ldap
```

Existing configuration files need no migration; omit these keys to retain the
Docker default.

## Development

```bash
git clone https://github.com/klovekesh37/rc-repro.git && cd rc-repro
pip install -e ".[dev,gui,browser]"
pytest                         # no Docker needed
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the layout and how to add a preset.
