---
name: verify-houston
description: Verify recurring Houston v2 CLI migrations through bin/houston with isolated state and durable command receipts. Use for capability discovery, missing-workspace failures, offline resource inspection, evidence JSON or bundles, SSH access handoff, onboarding persistence and teardown authority refusals, goal-first setup, and capture preflight; consult pending recipes for live engine behavior and successful browser capture.
---

# Verify Houston

This repository verifier exercises the real checkout entry point and parser. It
uses synthetic persisted workspace files and keeps real engine executables unavailable.
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

To drive another feature checkout without copying this skill into it, add
`--checkout /absolute/candidate/checkout`. Install dependencies in that candidate
first and keep its source fixed during the run. The receipt records the candidate
path, head and tracked diff digest, plus this verifier script's digest. Fingerprint
lookups use a resolved Git executable with a scrubbed Git environment, an explicit
candidate checkout, and a verified Git top level. Store evidence outside both
checkouts.

The helper requires Python 3.9+, Node, `dirname`, and `readlink`. Process-group
cleanup supports Darwin and Linux only and requires `waitid` with `WNOWAIT`.
Other POSIX platforms, or a missing cleanup primitive, refuse before command launch.
The non-POSIX fallback cleans up only the direct child and has no platform acceptance
proof; Windows and other platforms remain pending. On Linux, readable `/proc` process-status files
are also required to distinguish the reserved zombie leader from live group members.
It creates a unique
temporary directory containing `HOUSTON_HOME`, `HOUSTON_SKILL_HOME`, a synthetic
user home, a candidate temp directory, and synthetic Docker, Kubernetes, IPv6 and wildcard-bind workspaces. Every candidate
command gets `TMPDIR`, `TMP`, and `TEMP` pointed at that candidate temp directory. Node executable discovery uses an isolated temporary home and a minimal environment,
retaining caller PATH only to resolve the installed Node shim. It excludes caller
Node options, module paths, credentials, and other overrides. Only
entry-point utilities are initially on the CLI child's PATH. The onboarding refusal
drive adds a disposable kubectl trap and requires it never to be invoked. It passes no inherited credentials, engine sockets, kubeconfig,
proxy variables, or Houston overrides. Do not broaden that environment to make a
check pass.

Each CLI process has a 60-second timeout and completes before the next command.
The runner retains at most 4 MiB from each of stdout and stderr. Output beyond
either limit fails the command and triggers cleanup; discarded output cannot
produce a passing receipt.
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
`fixture_unchanged: true`, plus `source_unchanged: true`. Check `head` against the intended candidate and inspect
`diff_sha256` when verifying uncommitted tracked changes. This fingerprints tracked
diffs only. `candidate-source.json` additionally hashes tracked and untracked
nonignored CLI source, entry points, tools, packaged data and dependency manifests.
The helper refuses a run if that manifest changes during verification. Commit
verifier changes before final acceptance and record the exact
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
JSON and bundle output against the synthetic record. Every driven command descriptor must advertise literal `json: true`, a string
array of flags, the required flags, and the known schema. Incompatible discovery
fails before driving that feature. Missing mandatory baseline commands are failures.
An advertised `capture` command also gets an explicit missing-workspace drive,
which must refuse without creating a bundle or starting a browser.

An absent optional port is pending. An advertised port with an incompatible
recipe is a verifier drift failure, not permission to skip it. The helper probes `info` on the clean Docker fixture and the Kubernetes fixture.
When either payload has `data.access`, the SSH handoff drive runs for both
loopback runtimes, using only synthetic environment overrides. When both omit
the field, the port stays pending. An advertised `onboard` command triggers status, unknown-grant refusal,
grant and revoke drives in the run's disposable home. The helper checks the
persisted grant state, cluster scope and preservation of legacy settings.
The helper also requires local teardown to refuse missing onboarding and a denied
grant before invoking its kubectl trap. These synthetic answers grant nothing in
the operator's real home. When `onboard` advertises `--show`, it also drives the [setup recipe](features/setup.md).
Live engine behavior and successful capture require their pending
recipes to be extended against the candidate's actual help, source, and tests
before acceptance. A scoped baseline
pass leaves those paths pending until their actual consumer contracts are
exercised. Match command paths, flags, or documented payload fields, never version
strings or branch names, when choosing applicability.

## Evidence

`commands.json` records actual argv and exit codes. Each command has separate
stdout and stderr files. The helper scans each pair at the command-output boundary,
including refusals and timeouts, then requires both regular files for every expected command label and repeats
the scan over every retained command receipt before it can report `PASS_SCOPED`.
A symlink or other special entry anywhere in that retained tree fails the run.
Before scratch cleanup, a secret-bearing file in the candidate temp directory fails the run.
Failure receipts and `sha256.json` may still be written when that scan fails.
Require `summary.result: PASS_SCOPED` and a successful `summary.receipt_scan`;
the existence of a hash manifest does not establish acceptance. `summary.json`
binds results to the revision, records the fixture immutability check, and names
pending coverage. The helper reads retained files back after cleanup. Evidence bundles,
when applicable, also survive under the evidence directory.

Pass predicates live in each feature recipe and the helper. Inspect failures and
pending fields before reporting acceptance. Only synthetic data belongs in this
run. Real `info --json`, environment dumps, and deployment artifacts can contain
credentials and must not become attachable proof. The evidence recipe deliberately
plants a synthetic secret to detect leaks.

## Cleanup

The helper removes only the scratch directory it created, including the fixture,
in a `finally` block on success or ordinary failure. On Darwin and Linux, it keeps the CLI
leader unreaped while it force-kills the command group and confirms it has no live
member before reaping the leader. Linux checks the cleanup deadline before and
after each `/proc` entry iteration and status read; an OS call already in progress
cannot be preempted, so a later expired-deadline check fails the command rather
than treating the scan as empty. Pipe closure does not complete that cleanup. The
non-POSIX path has only direct-child cleanup. The onboarding path runs two guarded synthetic
`down --name verify-owned-kube-fixture --yes --json` probes. Its isolated home
and `kubectl` trap require the missing-onboarding and denied-grant gates to stop
before a cluster client or mutation can run. No `prune`, Docker, Kubernetes,
cloud, or service mutation command reaches a real target. A hard interpreter
termination can leave its uniquely named `verify-houston-*` scratch directory;
remove only that run's confirmed directory after checking its owner and retaining
proof. Never clean by a shared name or glob.

Read `summary.json` and `sha256.json` after the helper exits. Keep the evidence
directory for the parent or reviewer. End the verification report with the exact
branch/head, this skill's name, demonstrated CLI paths, and remaining pending or
live-runtime coverage.
