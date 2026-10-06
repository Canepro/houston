---
name: houston
description: Use when someone asks to create, spin up, boot or start a Rocket.Chat workspace or server on a given version ("a workspace on 7.4.1"), reproduce a support ticket or reported behaviour, check whether a bug is version-specific, or compare two versions; with LDAP, SAML, OIDC, email, S3/MinIO, livechat or air-gapped; to seed sample data, list what is running, read logs, back up, restore or upgrade a workspace, or tear it down. Drives the `houston` CLI, which runs a version-matched Rocket.Chat and MongoDB on Docker or Kubernetes.
---

# houston

houston boots a version-matched Rocket.Chat paired with a compatible MongoDB, on
Docker Compose or Kubernetes, with optional backing services (LDAP, SAML/OIDC,
email, S3, several instances) and sample data. It is for reproducing a customer's
issue on their exact version, then removing it.

Do **not** use it to inspect a customer's live workspace, or when the question is about
documented behaviour rather than observed behaviour.

## Requests and the commands they mean

`<n>` is the workspace's name: what you pass to `--name` when you create it, and
`data.name` from the `up` reply when you report it (see [Naming](#naming)). Add `--json` where the
command takes it and read the last line (see [The output contract](#the-output-contract)).
`houston capabilities` always prints JSON and takes no `--json`.

| The person asks | Run | Then |
|---|---|---|
| a workspace on 7.4.1 | `houston up --version 7.4.1 --name <n> --wait --json` | `houston info --name <n> --json`, and report back |
| the same with LDAP | `houston up --version 7.4.1 --name <n>-ldap --preset ldap --wait --json` | a **new name**: an existing one is reused as it was |
| SAML, OIDC, email, S3, livechat, offline | `--preset saml`, `oidc`, `email`, `s3_minio`, `livechat` or `airgapped` on `up` | `oidc`: ask the person to add `127.0.0.1 keycloak` to `/etc/hosts` |
| the customer's MongoDB version too | `houston up --version 7.4.1 --mongo 6.0 --name <n> --wait --json` | only when the ticket names it |
| several Rocket.Chat instances | `houston up --version 7.4.1 --name <n> --deployment multi-instance --replicas 3 --wait --json` | Docker only |
| put some data in it | `houston seed --name <n> --profile standard --verify-seed` | exit 0 means the readback matched ([Sample data](#sample-data)) |
| 50k users, a huge room | `houston seed --name <n> --scale users=50000,messages=800000@general` | undo with `houston seed --name <n> --clear-scale`; Docker only |
| what's running | `houston list --json` | `data.repros[]`: `name`, `owner`, `rc_version`, `state`, `links[0].url`; every workspace on the machine |
| show the logs | `houston logs --name <n> --tail 200` | never `-f`: it does not return |
| is it up yet | `houston ready --name <n> --json` | one call waits up to `--timeout` seconds (300); on exit 5 read `houston logs --name <n> --tail 200` before asking again |
| upgrade it to 8.0.0 | `houston upgrade --name <n> --to 8.0.0 --dry-run`, then without `--dry-run` | it must be running; if the dry-run refuses, stop and tell the person what it said, otherwise go ahead; it backs up first; `houston upgrade --name <n> --rollback` undoes it; a version needing another MongoDB major is refused |
| back it up | `houston backup --name <n> --label "<why>"` | `houston backups --name <n>` lists the bundles |
| restore a bundle | `houston restore <bundle> --new` | restoring in place replaces data: ask first |
| change a setting | `houston api --name <n> --2fa POST /api/v1/settings/<Id> -d '{"value":<v>}'` | or `houston env --name <n> --setting <Id>=<v>` on Docker |
| load the customer's settings | `houston config-import <file> --name <n> --dry-run`, then without `--dry-run` | report what was skipped |
| compare 7.4.1 and 8.0.0 | two `up`s with different names, one after the other | report both, remove both |
| pause it, resume it | `houston stop --name <n>`, `houston start --name <n>` | |
| tear it down | `houston down --name <n> --volumes --yes --json` | only workspaces you created; backup bundles in `~/.houston/backups/` are kept |
| which MongoDB goes with a version | `houston versions 7.4.1` | |
| what clusters there are, and their cost | `houston cluster overview --json` | the safe read: every cluster, its state, cost a day, reminder date and next step; it changes nothing and buys nothing |

### Naming

- **Always pass `--name`.** Use the ticket id when there is one (`--name TICKET-1234`).
  Otherwise use `rc` plus the version with dashes, plus the preset: `rc7-4-1-ldap`.
- Names are lowercased, and anything outside `a-z`, `0-9` and `-` becomes `-`, up to
  64 characters. With accounts on the machine, houston puts the owner (`HOUSTON_USER`)
  in front: `lucy-ticket-1234`. Later commands accept the name you typed as well, and
  `data.name` from the `up` reply is the name to report. Build a new name (`<n>-ldap`)
  from the name you chose, not from `data.name`, or the owner prefix is applied twice.
- **An existing name is reused exactly as it was.** A different version or preset is
  ignored, with a `VERSION_IGNORED_ON_REUSE` warning in the reply. A new preset needs a
  new name; a new version means `upgrade`.

### Versions

**Never boot a partial version.** "7.4" is not a release: it boots a `7.4` image tag
that may not be the patch the customer runs. Ask for the full version, or run
`houston versions 7.4.1`: `resolved via : releases.rocket.chat` is a real release, and
`map (no such release)` means ask the person. `versions` confirms a version you have; it
cannot find the customer's patch for you. The same applies to `upgrade --to`.

### What to tell the person afterwards

From `houston info --name <n> --json`:

- the URL: `data.links[0].url`;
- the admin login: `data.login.user` and `data.login.password`. It is `admin` /
  `admin123` only for a workspace on loopback; one with `--domain` or a wider `--bind`
  gets a generated password, so always read it;
- a preset's own logins and consoles, from `data.notes` (`ldap`, `saml` and `oidc` users
  are `user1` / `user1`);
- the Rocket.Chat and MongoDB versions it runs (`data.rc_version`, `data.mongo_tag`);
- that it is still running, and the command that removes it.

### Ask a person first

- anything that touches a cloud cluster: `cluster create`, `cluster delete`,
  `cluster keep` (it moves the date a cluster is meant to go by), `cluster share` (it
  grants somebody access in AWS and in the cluster), `up` with `--context` naming a
  cloud cluster, or `up --runtime kubernetes` without `--context`
  when `houston doctor --json` names a cloud cluster as the one it would use. If a ticket
  needs EKS and no cluster exists, say so and ask; never create one. A local Kubernetes
  workspace is a stand-in only if the person agrees;
- `--bind` beyond `127.0.0.1`, or `houston config set bind_host`;
- `--reg-token`: a registration token is a real licence, never paste one into a case;
- `down --volumes`, `prune`, or an in-place `restore` of a workspace you did not create.
  `down --volumes`, `prune` and `cluster delete` ask for confirmation; pass `--yes` only
  once the person has agreed, or for a workspace you created;
- exit 6: show `error.gate.approve_with` to the person, never run it yourself;
- `houston trust-ca`, or editing `/etc/hosts`.

## Three standing rules

1. **Read `houston capabilities` first.** It is JSON, needs no container engine,
   and is the authority for *this build* on which commands exist, which accept
   `--json`, which stream progress, what the error codes are and what each exit
   code means. Do not assume a flag exists because it did in another version.
2. **Branch on the exit code and `error.code`, never on prose.** Messages get
   reworded between releases; codes do not.
{{exit_codes}}

   `capabilities.exit_codes` is the whole table, and `capabilities.error_codes` says
   which are advertised.
3. **Never import houston's internals and never scrape human output.**
   Use `--json` on the commands that have it — `capabilities.commands[].json` says
   which, and it is a minority, not all of them: {{json_commands}} (`capabilities` prints
   JSON without the flag). For the rest (`seed`, `logs`,
   `env`, `backup`, `restore`, `upgrade`, `prune`, `tls-status`, …) the **exit code** is
   the machine-readable part. stdout is the document; anything on stderr is for a
   person.

## The output contract

Every `--json` reply is one envelope:

```json
{"schema":"houston.info.v1","contract":2,"houston_version":"{{houston_version}}",
 "generated_at":"...","ok":true,"data":{...},"warnings":[],"error":null}
```

Only {{streams}} stream: NDJSON `houston.event.v1` progress lines first, then exactly
one envelope as the **last line**. Read to the end of the output and parse the last
line, which is the right way to read every reply. A failure is the same envelope with
`ok: false` and `error.code` set; there is always exactly one, even when the failure
was unexpected (its stack trace goes to stderr, never stdout).

`contract` is the wire generation: if you do not recognise it, refuse rather than
guess. New keys may appear in `data` or `warnings`; ignore ones you do not know.
`down --volumes --json` needs `--yes`, because there is nobody to prompt.

## Details by topic

### Presets

`capabilities.presets` lists what this build has: {{presets}}. A preset starts the side
service, wires Rocket.Chat to it and turns the feature on, so it is ready when you
arrive: an `ldap` workspace has users, an `email` one catches every message Rocket.Chat
sends, `airgapped` has no route to Rocket.Chat Cloud. `houston presets` prints each
preset's `--set` parameters; `--set users=130000` on `ldap` is the large-directory case.

- `--preset` takes a **name from that list, never a path**.
- **One preset per workspace.** Boot two workspaces rather than combining scenarios.
- Several instances is `--deployment multi-instance`, not a preset, and cannot be
  combined with one. `--preset multi-instance` is the old spelling; it still works,
  and warns.

### Sample data

A profile contains every kind of room, because tickets are rarely about a public
channel: channels, teams, discussions, direct messages, threads and reactions.
`standard` is 22 rooms, 287 messages, 48 threads across 20 users.

Seeding reads everything back and checks it against the plan. **Treat a false or
missing result as unproven**; do not infer success from a 2xx write.
`--verify-seed` makes a mismatch fail the command. `seed` has no `--json`, so its exit
code is the answer; afterwards `houston info --name <n> --json` shows `data.seed.ok`.
Seeded users are `alice`, `bob` and so on, each with the username as the password.

### Where it runs

`--runtime` is `docker` (default) or `kubernetes`; `--deployment` is `monolith` or
`multi-instance` on Docker, `microservices` (default) or `monolith` on Kubernetes.
`capabilities.runtimes` lists the legal pairs, and an illegal one is refused before
anything is created.

On Kubernetes: `--context <name>` picks a cluster (and implies `--runtime kubernetes`),
and the workspace records it, so later commands for that workspace go there. Without
one, houston uses its own kind cluster if kind is installed, or else the cluster
`kubectl` points at. `houston doctor --json` names the cluster and what it provides
(`storage`, `ingress`, `loadbalancer`, `metrics`); do not infer those from the
distribution's name.

### What Kubernetes refuses, and why

Each refusal names the reason and the alternative:

- `--fresh`: it means delete this workspace's data, and the Kubernetes path keeps the
  volume. `houston down --name <n> --volumes` does delete it.
- `loadtest` and `capacity`: the traffic would pass through one `kubectl port-forward`,
  and the numbers would measure the forward. Use a Docker workspace on the same version.
- any `env` change: an environment variable is a Helm value there. Use `houston api` for
  a setting.
- `seed --scale`: Docker only. `houston seed` works on both.

`stats` needs metrics-server and says how to install it. Everything else works on both
runtimes.

### HTTPS on Kubernetes works

`--domain` cert-manager obtains a Let's Encrypt
certificate and TLS ends inside the cluster. Right after a create, a placeholder
certificate means cert-manager has not issued yet, which is normal for a few minutes:
`houston tls-status --name <n>` re-checks (it has no `--json`; exit 1 naming the
ingress controller's placeholder, with the workspace up, is "still coming"). `--https`,
houston's own CA, is refused on a cluster that is not on this machine; `--domain` is the
answer there.

### Cloud clusters cost money, and `up` never creates one

`houston cluster create` takes about twenty minutes and **bills from the first minute
whether or not anything runs in it**; only `houston cluster delete` stops it. `up`
cannot create one, structurally. Before saying nothing is running, run `houston cluster
list --json`: it checks every enabled region, and a region listed under `unreadable` is
NOT covered by the answer. The whole procedure is `houston cluster guide`.

### Collect what a case needs

`houston info --name <n> --json` is the record to attach: version, MongoDB pairing,
runtime and deployment, links, and on Kubernetes the namespace and the pods, with the
reason any cannot start. Credentials in its env listing are masked.

### Tear it down

**Tear down by default.** A workspace costs about 1.1 GB on Docker and more on
Kubernetes, `up` refuses when the machine lacks room, and too many at once can run a
machine out of memory. Remove the workspaces you start for your own checks. A workspace
the person asked for is theirs: leave it running, say so, and give them the command that
removes it.

`--volumes` deletes the data and the record and cannot be undone. Without it the data
is kept, and the same `up` brings the workspace back.

`down --volumes` can **refuse** with exit 5 and a warning, keeping the record, so
`list` still showing the workspace is correct. That 5 means "it is still there, read the
warning", not "poll again". The usual cause is a Kubernetes namespace that will not
finish terminating.

On Kubernetes, `down` leaves the shared cluster running; `houston prune` removes it only
if houston created it and no houston namespace remains.

## When the envelope is not enough

Every command appends to `$HOUSTON_HOME/logs/houston.log` (default
`~/.houston/logs/houston.log`): one JSON object per line, credentials dropped. Each
line carries a `run` id for one command, so `grep '"run":"<id>"'` on that file shows it
from start to end. Use it when `error.code` says what failed and you need when and in
what order. It is for reading, not a contract.

## Things that will bite you

- **The first run is slow.** Images have to be pulled. Do not treat the first duration
  as typical or kill it early.
- **`up` can refuse for capacity.** That is a preflight, not a hiccup: free something
  rather than retrying.
- **Version pairs matter.** houston picks the MongoDB for a Rocket.Chat version. Do not
  override it unless the ticket names one.
- **Everything binds `127.0.0.1`** unless told otherwise, because workspaces use weak,
  well-known credentials. Widening that is a decision for a person.

## If this skill is stale

`capabilities.skill.current` is false when a copy that exists does not match the
build. `capabilities.skill.hosts` names each one and its scope:

- `project` — the checkout's own `.claude/skills/houston/SKILL.md`. This is the one
  in play when you are working inside the repository, and it travels with the branch.
- `user` — `~/.claude/skills/` and `~/.agents/skills/`, for a machine with no
  checkout. `houston skill install` writes these; it refuses to overwrite a copy
  you have edited unless you pass `--force`.

Prefer `capabilities` over this file wherever the two disagree. That one is
generated from the build; this is prose, and prose goes stale.
