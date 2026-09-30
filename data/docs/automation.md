# Scripts and coding agents

houston is built to be driven by a script or a coding agent as well as by a person.
This guide covers the machine-readable parts: `--json`, `houston capabilities`, exit
codes, the event log and the agent skill.

The rule underneath all of it: **branch on the exit code and `error.code`, never on
the wording.** Messages get reworded between releases; codes do not.

---

## `--json`

These commands take `--json`: `up`, `ready`, `down`, `list`, `info`, `doctor`,
`loadtest`, `capacity`, `cluster` and `skill`. `capabilities` always prints JSON. For
the other commands, the exit code is the machine-readable part.

Every reply is one envelope:

```json
{"schema":"houston.info.v1","contract":2,"houston_version":"2.0.0",
 "generated_at":"…","ok":true,"data":{…},"warnings":[],"error":null}
```

- A failure is the same envelope with `"ok":false`, `"data":null`,
  `"schema":"houston.error.v1"` and an `error` object with a stable `code` and a
  `message`.
- `up` and `ready` **stream**: progress lines (NDJSON, `houston.event.v1`) first, then
  exactly one envelope as the **last line**. Read to the end and parse the last line.
  That is the right way to read every reply, streaming or not.
- stdout carries JSON and nothing else. Anything meant for a person goes to stderr.
- `contract` is the format generation. If you do not recognise it, stop rather than
  guess. `schema` versions each kind of payload.
- New keys may appear in `data` and `warnings`. Ignore the ones you do not know.
- `down --volumes --json` needs `--yes`, because there is nobody to ask.

---

## `houston capabilities`

`houston capabilities` prints JSON, needs no Docker, and is the authority for **the
build you have**: which commands exist, which take `--json`, which stream, the
runtime and deployment pairs, the presets, the seed profiles, the progress phases,
the error codes and the exit codes. Read it instead of assuming a flag exists because
it did in another version.

---

## Exit codes

| Code | Meaning | `error.code` | What to do |
|---|---|---|---|
| 0 | ok | — | — |
| 1 | internal | `REPRO_ERROR` | a refusal of no more specific kind, or an unexpected failure (its stack trace is on stderr). Read the message |
| 2 | usage | `VALIDATION_FAILED` | the call is wrong: a flag, an argument or a value. Retrying it unchanged will not help |
| 3 | preflight | `PREFLIGHT_FAILED`, `ENGINE_UNAVAILABLE` | the machine is not ready. Run `houston doctor` |
| 4 | not found | `NOT_FOUND` | no such workspace |
| 5 | not ready | `NOT_READY` | from `ready` or `up --wait`: still starting, poll again. From `down --volumes`: the workspace is still there; read the warning instead of retrying |
| 6 | gate | `GATE_*` | a person has to decide. Never retry it, and never approve it yourself |
| 7 | create failed | `CREATE_FAILED` | the workspace did not come up. Stop; do not retry in a loop |
| 8 | conflict | `CONFLICT` | the name or port is taken. Pick another |

`houston capabilities` carries the same table as `exit_codes`.

**Exit 6 is an authority gate.** Three things raise it:

- `cluster create` in an AWS account this machine has not been approved to spend in
  (`GATE_CLOUD_SPEND`);
- `cluster delete` on a cluster houston did not build (`GATE_DELETE_UNOWNED`);
- `--https` on a cluster that is not on this machine (`GATE_UNAPPROVED_CLUSTER`).

The error has a `gate` object, and `error.gate.approve_with` is the command to **ask a
person to run**. It is not something a script or agent may run itself, and `--force`
does not get past it.

Other things worth knowing:

- **130** is an interrupt (Ctrl-C): no message, no envelope.
- **252** comes from `bin/houston` itself, when it cannot find houston's code next to
  it. Nothing ran, stdout is empty, and one line on stderr says where it looked.
- Not every refusal is typed. A plain one, such as an out-of-range `--vus`, exits 1.
  Test `$? -ne 0` for "did it fail", and use the table where a command documents it.
- **`doctor` differs on purpose.** A failed check exits 1 in normal output and 3 with
  `--json`: 3 is what a script branches on, and a person has already read the reason.

---

## The event log

Every command, even `--help`, appends to `~/.houston/logs/houston.log` (or
`$HOUSTON_HOME/logs/houston.log`): one JSON object per line, mode 0600, with credentials
dropped. Each line has a `run` id that stays the same for one command, so this shows
one command from start to end:

```bash
grep '"run":"<id>"' ~/.houston/logs/houston.log
```

Use it when `error.code` says **what** failed and you need to know **when** and **in
what order**. The log is for reading, not a contract: it has no `schema` and may change.
`HOUSTON_LOG_MAX_MB=0` turns it off. It leaves out the progress lines Docker prints while
pulling images, which would fill it during a single `up`; `HOUSTON_LOG_ECHO=1` keeps
them, for debugging a pull. Warnings and errors are always kept.

**Scripts and tests should not write to your real log.** Point houston at a throwaway
home first:

```bash
export HOUSTON_HOME=$(mktemp -d)
```

---

## Coding agents

houston ships a skill file that teaches a coding agent, such as Claude Code, how to
use this build: which command to run for a request, how to read the replies, and what
to ask a person first.

```bash
houston skill install          # into every agent skills directory houston knows
houston skill install --host claude
houston skill status           # installed, current, stale or edited
```

`houston capabilities` reports `skill.current: false` when an installed copy no longer
matches the build. `skill install` will not overwrite a copy you edited unless you pass
`--force`. A checkout of this repository carries its own copy, which an agent working
inside the repository uses.
