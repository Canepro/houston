# Scripts and coding agents

The machine-readable parts of houston: `--json`, `houston capabilities`, exit codes, the
event log and the agent skill. **Branch on the exit code and `error.code`, never on the
wording**: messages get reworded between releases, codes do not.

---

## A worked example

```bash
export HOUSTON_HOME=$(mktemp -d)                 # a throwaway home, not your real one
houston up --version 8.5.1 --name t1 --wait --json | tail -n 1 | jq '.ok, .error.code'
houston ready --name t1 --json | tail -n 1 | jq '.ok'
houston down --name t1 --volumes --yes --json | tail -n 1 | jq '.ok'
```

On a shared machine, set `HOUSTON_USER=<account>` so the audit log names who ran it.

## `--json`

`up`, `ready`, `down`, `list`, `info`, `inspect`, `evidence`, `capture`, `doctor`, `loadtest`,
`capacity`, `cluster`, `onboard` and `skill` take `--json`; `capabilities` always prints JSON. Every reply is one envelope:

```json
{"schema":"houston.info.v1","contract":2,"houston_version":"2.1.1",
 "generated_at":"…","ok":true,"data":{…},"warnings":[],"error":null}
```

- **Parse the last line.** `up` and `ready` stream progress lines (`houston.event.v1`)
  first, then the envelope.
- A failure has `"ok":false`, `"schema":"houston.error.v1"` and an `error` with a stable
  `code` and a `message`.
- `warnings` holds every distinct warning the command raised, each a `code` and a
  `message`, in the order raised. Branch on the code; most share the generic `WARNING`.
- stdout is JSON only; anything for a person goes to stderr.
- An unknown `contract`: stop. Unknown keys in `data`: ignore them.
- `down --volumes --json` needs `--yes`.

## `houston capabilities`

JSON, no Docker needed, and the authority for **this build**: its commands and which take
`--json` or stream, runtimes and deployments, presets, seed profiles, onboarding state, phases,
error codes and exit codes. Read it instead of assuming a flag exists.

## Exit codes

| Code | Meaning | `error.code` | What to do |
|---|---|---|---|
| 0 | ok | — | — |
| 1 | internal | `REPRO_ERROR` | a refusal of no more specific kind, or a crash (stack trace on stderr). Read the message |
| 2 | usage | `VALIDATION_FAILED` | the call is wrong (a bad flag value, a missing argument, an unknown action); retrying unchanged will not help |
| 3 | preflight | `PREFLIGHT_FAILED`, `ENGINE_UNAVAILABLE` | the machine is not ready: run `houston doctor` |
| 4 | not found | `NOT_FOUND` | the thing named is not there: a workspace, a file, a saved baseline |
| 5 | not ready | `NOT_READY` | from `ready` or `up --wait`: poll again. From `down --volumes`: it is still there, read the warning |
| 6 | gate | `GATE`, `GATE_*` | a person has to decide; see below |
| 7 | create failed | `CREATE_FAILED` | it did not come up. Stop; do not retry in a loop |
| 8 | conflict | `CONFLICT` | the name or port is taken |
| 9 | capture failed | `CAPTURE_FAILED` | the scripted browser capture stopped or its artifacts did not hold up; inspect the retained partial bundle |
| 130 | interrupt | — | Ctrl-C: no envelope |
| 252 | no code | — | `bin/houston` could not find houston's code; nothing ran |

`doctor` exits 1 on a failed check in normal output, and 3 with `--json`.

**Exit 6, a gate**, needs a person. The codes:

| Code | Raised by |
|---|---|
| `GATE_CLOUD_SPEND` | `cluster create` in an AWS account not approved on this machine |
| `GATE_DELETE_UNOWNED`, `GATE_KEEP_UNOWNED`, `GATE_SHARE_UNOWNED` | `cluster delete`, `keep` or `share` on a cluster houston did not build |
| `GATE_WRONG_ACCOUNT` | `cluster connect` or `cluster delete` when the AWS sign-in is a different account from the cluster's |
| `GATE_WRONG_CLUSTER` | `cluster delete` when AWS returns a different cluster than the one selected |
| `GATE_NOT_ONBOARDED` | a local-cluster lifecycle action before onboarding is recorded |
| `GATE_OWNED_CLUSTER` | creating or reclaiming `houston-local`, or tearing down or pruning one of its recorded local workspaces |
| `GATE_UNAPPROVED_CLUSTER` | `--https` on a cluster that is not on this machine |

`error.gate.approve_with` is the command or action to **ask a person for**. A script or
agent never runs it itself, and `--force` does not get past a gate.

For the local-cluster decision above, a person can review the current state with
`houston onboard --json`, record that review with `houston onboard complete`, or run the
`houston onboard grant owned-cluster` command named in the gate. It does not authorise
copying houston's private CA key to another cluster.

## The event log

Every command appends JSON lines to `$HOUSTON_HOME/logs/houston.log` (default
`~/.houston`), with credentials dropped. One command shares a `run` id:

```bash
grep '"run":"<id>"' ~/.houston/logs/houston.log
```

It is for reading, not a contract. `HOUSTON_LOG_MAX_MB=0` turns it off;
`HOUSTON_LOG_ECHO=1` also keeps Docker's pull lines.

## Coding agents

houston ships a skill that teaches an agent, such as Claude Code, how to use this build:
which command fits a request, how to read the replies, and what to ask a person first.

```bash
houston skill install          # into every agent skills directory houston knows
houston skill install --host claude
houston skill status           # absent, current, stale or modified
```

`skill install` will not overwrite a copy you edited (`modified`) unless you pass
`--force`. `houston capabilities` reports `skill.current: false` when an installed copy
is out of date.
