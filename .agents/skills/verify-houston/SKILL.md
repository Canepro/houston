---
name: verify-houston
description: Verify recurring Houston v2 CLI migrations through bin/houston with isolated state and durable command receipts. Use for capability discovery, missing-workspace failures, and evidence JSON or bundles; consult pending recipes for resource inspection, SSH access handoff, onboarding, and capture.
---

# Verify Houston

This repository verifier exercises the real checkout entry point and parser. It
uses synthetic persisted workspace files and makes engine executables unavailable.
Its offline result does not establish Docker, Kubernetes, authentication, or
browser behavior. Keep the generated application skill in `data/skill/` and its
mirrors under their existing generator's ownership.

## Launch

Run from the checkout root. Follow `CONTRIBUTING.md` for Node and the pinned Yarn
installation, then install dependencies with `yarn install --immutable`. On this
checkout `bin/houston` executes source through `tools/cli.js`; it ignores an old
`dist/` tree. No build or daemon is needed for this verifier.

Choose a new absolute evidence directory outside the checkout and any cleanup
root, then run:

```bash
python3 .agents/skills/verify-houston/scripts/verify.py --evidence-dir /absolute/durable/proof/run-001
```

The helper requires Python 3.9+, Node, `dirname`, and `readlink`. It creates a unique
temporary directory containing `HOUSTON_HOME`, `HOUSTON_SKILL_HOME`, a synthetic
user home, and the workspaces `verify-fixture` and `verify-kube-fixture`. Only
entry-point utilities are on the child's PATH. It passes no inherited credentials, engine sockets, kubeconfig,
proxy variables, or Houston overrides. Do not broaden that environment to make a
check pass.

Each CLI process has a 60-second timeout and completes before the next command.
Readiness means version and capability envelopes match `package.json`, followed
by the expected missing-workspace refusal. There is no listener to bind and no
persistent process or container to stop. Parallel runs require different evidence
directories; scratch homes are unique per invocation.

## Doctor

Read the retained launch result:

```bash
python3 -m json.tool /absolute/durable/proof/run-001/summary.json
```

Require `result: PASS_SCOPED`, `scratch_removed: true`, and
`fixture_unchanged: true`. Check `head` against the intended candidate and inspect
`diff_sha256` when verifying uncommitted tracked changes. This fingerprints tracked
diffs only; commit verifier changes before final acceptance and record the exact
head in the delivery receipt. Version alone cannot distinguish two same-version
branches. The underlying read-only CLI probe is `bin/houston --version` inside the
helper's isolated environment. Do not use the application's infrastructure
`doctor` command as a substitute for this offline probe.

## Drive

Read [the feature map](features/index.md), then the recipe for each changed path.
The helper drives `--version`, `capabilities`, and an unknown workspace through
`info --json`. If capabilities advertise `inspect`, it drives both offline
runtime fixtures and the missing-workspace failure. If `capabilities.data.commands` advertises
`evidence`, it also drives
JSON and bundle output against the synthetic record. It fails if the advertised
flags or known contract differ. Missing mandatory baseline commands are failures.

An absent optional port is pending. An advertised port with an incompatible
recipe is a verifier drift failure, not permission to skip it. SSH handoff,
onboarding, and capture require their pending recipes to be extended against the
candidate's actual help, source, and tests before acceptance. A scoped baseline
pass leaves those paths pending until their actual consumer contracts are
exercised. Match command paths, flags, or documented payload fields, never version
strings or branch names, when choosing applicability.

## Evidence

`commands.json` records actual argv and exit codes. Each command has separate
stdout and stderr files. `summary.json` binds results to the revision, records the
fixture immutability check, and names pending coverage. `sha256.json` hashes the
retained files and the helper reads them back after cleanup. Evidence bundles,
when applicable, also survive under the evidence directory.

Pass predicates live in each feature recipe and the helper. Inspect failures and
pending fields before reporting acceptance. Only synthetic data belongs in this
run. Real `info --json`, environment dumps, and deployment artifacts can contain
credentials and must not become attachable proof. The evidence recipe deliberately
plants a synthetic secret to detect leaks.

## Cleanup

The helper removes only the scratch directory it created, including the fixture,
in a `finally` block on success or ordinary failure. Timeout terminates the CLI
child. The allowed commands start no persistent workers. No `down`, `prune`,
Docker, Kubernetes, cloud, or service mutation command is used. A hard interpreter
termination can leave its uniquely named `verify-houston-*` scratch directory;
remove only that run's confirmed directory after checking its owner and retaining
proof. Never clean by a shared name or glob.

Read `summary.json` and `sha256.json` after the helper exits. Keep the evidence
directory for the parent or reviewer. End the verification report with the exact
branch/head, this skill's name, demonstrated CLI paths, and remaining pending or
live-runtime coverage.
