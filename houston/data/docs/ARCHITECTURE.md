# Architecture

How houston is built, and why. [`README.md`](../../../README.md) is the user guide and
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) covers preset authoring; this is the document to
read before changing anything.

Most of what follows is a decision with a cost attached. The costs are not
hypothetical — nearly every one is written down because it was paid.

---

## What the tool is

houston reproduces a customer's Rocket.Chat issue on their exact version, in minutes.
One command boots a version-matched Rocket.Chat with a compatible MongoDB, optional
backing services (LDAP, SAML/OIDC, email, S3, multi-instance) and sample data —
instead of hand-building a compose stack for every support ticket.

```
houston up --version 8.5.1 --name TICKET-1234 --wait
houston down --name TICKET-1234 --volumes
```

It is maintained by the Rocket.Chat support team and optimised for one thing: getting a
faithful reproduction in front of an engineer quickly, then removing it completely.

---

## The shape of it

**Two front-ends over one service layer.** `houston <cmd>` is the terminal;
`houston serve` is a browser GUI that a support engineer can be handed without a
shell — named accounts, roles, an audit trail.

```
  cli.py                      web/app.py + web/jobs.py
  (option parsing,            (routes, ROUTE_ROLES,
   terminal rendering)         SSE/WS, job registry)
        │                              │
        └──────────────┬───────────────┘
                       ▼
                  services/
        the entire behaviour of the product
                       │
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
    runner.py       k8s.py        rcapi.py        eks.py
   Docker seam   Kubernetes    Rocket.Chat      AWS seam
                    seam         REST seam
```

**Both front-ends call the same `services/` functions.** This is the single most
important fact about the codebase. A change the GUI needs almost always belongs in
`services/`, not in `web/app.py`. When behaviour lives in a front-end, the other one
silently lacks it — and because the CLI is the one developers use, the GUI is always
the one that loses.

**Four seams to the outside world**, and nothing bypasses them:

| Seam | Owns |
|---|---|
| `runner.py` | Every `docker compose` invocation, on-disk state, host-port allocation, `repro_lock` |
| `services/k8s.py` | Every `kubectl` and `helm` invocation |
| `rcapi.py` | Every call to Rocket.Chat's REST API |
| `services/eks.py` | Every `aws` and `eksctl` invocation |

Keeping these narrow is what makes the test suite able to run without Docker, without a
cluster and without an AWS account.

---

## The decisions

### Progress is an `Event`, not a `print`

`services/events.py` defines `Event(message, phase, level, pct, data, terminal)` and
`Emit = Callable[[Event], None]`. Every long-running service function takes
`emit: Emit`, defaulting to `null_emit`. The CLI prints them; `web/jobs.py` buffers
them per job; the SSE endpoint streams them to the browser.

**Cost of breaking it:** a service function that prints instead of emitting is
invisible in the GUI. The mirror is equally true and has bitten too: a fact returned in
a result document but never emitted is invisible in the GUI's log — `cluster prepare`
computed the load-balancer address a support engineer has to act on, returned it, and
the browser never showed it.

### Failure is a raised `ReproError`, not `ui.die()`

`errors.py` attaches `http_status` to each subclass — `ValidationError` 400,
`ConflictError` 409, `NotFoundError` 404, `NotReadyError` 409, `DockerError` 502. The
CLI catches and renders a red line with exit 1; the web layer maps to the status.

**Cost of breaking it:** `ui.die()` raises `typer.Exit`, which is fine in a one-shot
process and **fatal in `serve`** — one bad request would exit the whole server. This is
why `services/` imports `ui` nowhere.

### "I could not ask" is not "it is not there"

The rule that governs `services/k8s.py`, and the one most likely to cause real damage
if forgotten. Types make it hard to get wrong:

- **`Answer`** — `PRESENT` / `ABSENT` / `REFUSED`, with no truthiness, so a caller must
  name which of the three it means.
- **`Reach`** — `REACH_OK` / `REACH_DENIED` / `REACH_NO_CONTEXT` / `REACH_DOWN`.

**Cost of breaking it:** `if res.returncode != 0: return []` is indistinguishable from
"the cluster holds none of these". Every instance has cost something — a refused read
once uninstalled the *shared* MongoDB operator out from under other workspaces; another
told an engineer with a working cluster they had no storage, no ingress and no nodes.
An invariant test walks the module's source to keep new reads from reintroducing it.

### Authorisation is a table, not scattered checks

`ROUTE_ROLES` in `web/app.py` is **DEFAULT DENY** — a route missing from it is
admin-only at runtime, and a test walks `app.routes` to prove none is unlisted.

It lives in the **web** layer deliberately. The CLI reaches the same service functions
and honours `HOUSTON_USER` as given, so a service-layer check would make
`HOUSTON_USER=<any admin>` a one-word privilege escalation.

Reads are readonly+, writes member+, people-management admin — with the exception of
reads that are not really reads. Logs, effective env, a minted PAT and an arbitrary
REST call all hand over credentials, so they are member+.

### Sessions are server-side so they can be ended

A 256-bit id, of which only the sha256 reaches disk. Idle 12h, absolute 7d,
`last_seen` flushed at most once a minute. This replaced HTTP Basic, which has no
logout. Sign-in rate limiting is per client address at the endpoint that spends the
scrypt — `services/users.py` cannot refuse on a counter without also refusing correct
passwords.

Password hashing is stdlib `hashlib.scrypt`. There is no bcrypt or passlib, on purpose.

### TLS is a runtime property, not a build-time one

A workspace never terminates TLS. One Traefik edge holds `:80`/`:443` for the whole
box, and a workspace gains or loses HTTPS by a **route file appearing or disappearing**
— not by being rebuilt. The edge joins a workspace's network live with
`docker network connect`; every workspace keeps its own network, so workspaces still
cannot reach each other.

Routes address the **container name**, never the service alias. Every workspace calls
its service `rocketchat`, and from an edge attached to many such networks the bare name
resolves deterministically to one of them — which looks stable under testing and would
silently serve the wrong workspace forever.

**Cost of the build-time version:** six compensating mechanisms, recorded in
`services/edge.py`'s docstring.

### `--json` is one envelope, and it is the last line

`jsonout.py` defines it: `{schema, contract, houston_version, generated_at, ok, data,
warnings, error}`. Streaming commands write NDJSON `houston.event.v1` progress lines
first, then exactly one envelope — so a caller reads to end-of-stream and parses one
line.

**stdout carries JSON and nothing else.** `jsonout.activate()` puts `ui` into stderr
mode for the process, which is why the prose helpers route through `ui` rather than
bare `typer.echo`. `PHASES` is a closed vocabulary and a test walks the source to prove
it.

### Capacity is a preflight that refuses, not a warning

`lifecycle.capacity()` / `check_capacity()` reserve host RAM headroom and block `up`.
The tool is usually run on a laptop already running other stacks, and the kernel picks
its own victim when it runs out.

### Everything binds loopback unless told otherwise

`PRESET_PORTS` in `config.py` is the one registry, so presets cannot silently collide;
Rocket.Chat's own port is allocated dynamically per workspace. Everything binds
`127.0.0.1` unless explicitly opted out, because reproductions ship weak fixed
credentials (`admin` / `admin123`).

---

## The three runtimes

`services/topology.py` holds three axes — runtime, deployment, replicas:

| Runtime | Deployment | Where it runs |
|---|---|---|
| `docker` | `monolith` (default), `multi-instance` | Docker Compose, this machine |
| `kubernetes` | `microservices` (default), `monolith` | any cluster — kind, k3s, EKS |

Most of the tool is runtime-agnostic: `seed`, `api`, `token`, `pat` and
`config-import` speak REST to a URL and do not care what is behind it. Only the handful
of commands that reach for a compose project need `topology.require_compose()`, which
refuses **and names the Kubernetes equivalent** — saying "not supported" without the
alternative leaves the user to find what the person writing the refusal already knew.

### The cloud is two verbs at two lifetimes

This separation is the one that keeps bills from happening:

| | `cluster create` | `up` |
|---|---|---|
| Lifetime | once per team | once per ticket |
| Cost | ~$0.35/hr, billing from minute one | free |
| Time | ~20 minutes | ~3 minutes |

**`up` can never create a cloud cluster**, and that is structural rather than a matter
of care: `plan_cluster()` adopts an explicitly named context and never provisions.

Two gates that look alike and are not: **AWS IAM decides whether you may build a
cluster; the cluster's own RBAC decides whether you may use it.** A cluster's creator
is auto-mapped; everyone else needs an EKS access entry. `houston cluster iam-policy`
ships three documents for exactly this reason.

---

## Where things live

### Root modules

| Module | Responsibility |
|---|---|
| `cli.py` | Typer commands: option parsing, terminal rendering |
| `runner.py` | **The only Docker seam.** On-disk state, host-port allocation, `repro_lock` |
| `rcapi.py` | **The only Rocket.Chat REST seam.** Readiness, auth, 2FA/OTP, settings |
| `compose.py` | Builds the docker-compose document |
| `config.py` | Paths, `PRESET_PORTS`, admin credentials, env overrides, persisted config |
| `errors.py` | The `ReproError` hierarchy with `http_status` — the failure contract |
| `jsonout.py` | The `--json` envelope, the closed phase vocabulary, `capabilities` |
| `versions.py` | Rocket.Chat version → MongoDB pairing (live lookup + shipped fallback) |
| `tls.py` / `tls_local.py` | ACME/Let's Encrypt; the local CA |
| `ui.py` | Terminal output helpers — **CLI only** |

### `services/` — the shared brain

`lifecycle` (create/ready/teardown/prune/detail — the big one) · `k8s` (the Kubernetes
seam, the largest module) · `eks` (the AWS seam) · `cluster` (the cluster ledger) ·
`perf` · `data` · `monitor` · `postready` · `diagnose` · `events` · `audit` · `backup` ·
`doctor` · `edge` · `topology` · `journal` · `eventlog` · `envvars` · `firstrun` ·
`sessions` · `skill` · `upgrade` · `users`.

`ls houston/services/` is the authority on the count. A number written here drifts the
first time somebody adds a module and forgets to come back.

### `web/` — the `serve` GUI

`app.py` (FastAPI routes, `ROUTE_ROLES`, Host guard, SSE/WS) · `jobs.py` (background
job registry) · `signin.py` (a **server-rendered** sign-in page, deliberately not a
state inside the SPA).

`web/jobs.py` is bounded on purpose: `MAX_JOBS = 100`, `MAX_EVENTS_PER_JOB = 2000`, and
finished jobs shed their full result document. A capacity search result measures
~118 KB, so a hundred held is ~69 MB for the life of a process on a box that hits RAM
before anything else.

### The GUI

Vanilla JS, no build step — `houston/data/webui/{index.html,app.js,app.css}`, shipped
as package data. Editing a file is enough.

**Colour is a signal, never decoration.** The rule is declared at the top of `app.css`
and is load-bearing: green = running, amber = wants you, red = about to destroy
something, blue = you can click it.

**Fields are absent, not disabled.** A control that cannot succeed is worse than no
control — it invites a click and explains itself only after the submit. The create
dialog removes options a runtime cannot honour rather than greying them out, and the
per-runtime refusal list comes from `/api/settings`, built from the same registry the
service enforces. A copy in JavaScript would still be refusing a flag the server
stopped refusing.

**The payload-shape trap.** Every browser test renders from `_fake_detail()` in
`tests/test_browser.py`. If a key differs from what `lifecycle.detail()` really
returns, the panel breaks in production with the whole suite green. An invariant test
compares the two.

---

## Performance: what is allowed to be slow

Every read of a remote cluster is a network round trip, and against EKS each is a
second or two. The rule that follows is about *which* operation may spend them:

| Operation | Budget | Why |
|---|---|---|
| `cluster list` | must probe **nothing** | The page draws every card from it; one slow cluster must not become a slow page |
| `cluster status` | per card, may probe | The front end fetches it per card and fills each in as it returns |
| `up`, `cluster create` | minutes | Real work — but it must **say so while it happens** |

Independent reads run concurrently. This is not micro-optimisation: sequentially,
`cluster status` measured **18.15s** against a real EKS cluster while the same box
answered the list in 0.31s, and `doctor` spent 1783ms of a 2485ms report waiting on
three `aws` calls that had nothing to say to each other.

**A long step must emit while it runs.** A `helm install --wait` prints nothing until
it returns, and on a first workspace that was **254 seconds of silence** — which is
where somebody decides the tool has hung and kills it, leaving a half-installed release
for the next `up` to clear.

---

## State

Everything lives under `HOUSTON_HOME` (default `~/.houston`):

```
config.yaml          users  sessions  (0600)     audit.log
presets/             backups/  reports/  loadtests/
acme/                edge/     journal/  logs/
clusters/<name>/     repros/<name>/{docker-compose.yml,repro.json}
```

The compose file is **generated** — re-run `up` rather than editing it.

**Ownership of a cloud cluster lives in AWS, not here.** A tag on the cluster, not a
file in `HOUSTON_HOME`, because a local ownership record is one `mktemp -d` away from
leaving a billable cluster houston can no longer prove is its own. A tag survives a
lost home, a different machine and a colleague.

The two *reporting* nets — the cost reminder `doctor` reads and the interrupted-create
journal — do live under `HOUSTON_HOME` and do not survive it. `doctor` says so when
the record is empty and the account is reachable, and points at the sweep that asks AWS
directly.

---

## Testing

Ten files, and **nothing in the suite needs Docker**. `ls houston/services/` and
`pytest --collect-only` are the authority on the counts — written down here they
would be wrong within a release, which is the lesson `CLAUDE.md` records paying
for twice.

| File | Covers | Needs |
|---|---|---|
| `test_core.py` | version resolution, presets, compose, perf, seed/import | — |
| `test_services.py` | the `services/` layer; error typing, event model | — |
| `test_web.py` | the HTTP API: guards, `ReproError` → status, jobs | `[gui]` |
| `test_browser.py` | GUI smoke, role-aware rendering | `[browser]` + chromium |
| `test_users.py` | unrecoverable passwords, constant-time unknown names, lockout | — |
| `test_team.py` | shared-server ownership and attribution | — |
| `test_edge.py` | the shared edge | — |
| `test_backup.py` | backup/restore/upgrade decision logic | — |
| `test_diagnose.py` | compose-failure signature matching | — |
| `test_json.py` | the `--json` contract | — |

**Two extras hide their own absence.** Without `[gui]`, `test_web.py` skips itself and
the entire HTTP/auth surface goes untested; without `[browser]` plus
`playwright install chromium`, `test_browser.py` does the same. Both report green while
testing nothing — that exact hole let a broken same-origin form POST ship while 570
HTTP tests passed. Install `".[dev,gui,browser]"`.

**Invariant tests walk the source.** `ROUTE_ROLES` against `app.routes`, `PHASES`
against the source, `doctor.CHECKS` against its call sites, and a walk that forbids a
kubectl read from answering a failed call with an empty one. Registries drift; walks
do not.

**A regression test must be proven to fail against the pre-fix code.** Stash the fix,
run the test, confirm it fails for the stated reason, restore. A test that passes both
ways proves nothing.

---

## The rule behind most of the rules

A support tool's worst failure is not crashing. It is **answering confidently and
wrongly** — reporting zero volumes for a cluster it could not read, certifying a URL
served by something else, saying a certificate failed when it had not arrived yet, or
telling somebody a cluster costs nothing because the pointer file was lost.

Most of this document is that one idea applied in different places: say what you know,
say what you could not find out, and never let the second turn into the first.
