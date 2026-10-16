# Goal-first setup

Read `src/core/setup.ts`, `src/cli/handlers/setup.ts`, the onboard command in
`src/cli/spec-data.ts`, and `src/web/routes/meta.ts` on the candidate. When onboard
advertises `--show`, the helper drives the real CLI in its disposable home after
the onboarding checks. The outer JSON schema remains `houston.onboard.v1`; setup
responses carry `data.schema: houston.setup.v1`. The helper validates this inner
schema independently on preview, save, readback, defaults and prompt readback.

The preview must preserve configuration bytes, report saved answers, and offer no
automatic infrastructure actions. Empty JSON setup, an invalid deployment, and
`--show` combined with a write must each refuse with exit 2 and
`VALIDATION_FAILED`, leaving the configuration unchanged.

The helper saves microservices, no scenarios, no seed, and retention enabled. A
separate preview process must read these choices back. Accepting defaults must
preserve those answers and the denied owned-cluster grant without rewriting the
configuration when every default was already answered. The resulting command must
use the saved topology. Parse it as shell tokens and allow only `houston up`,
one valued `--version`, one valued `--name`, and one valueless `--wait`. Version
and name values must be nonempty release and workspace-name tokens. Accept
separate or `--flag=value` arguments and shell quoting that preserves those
tokens. When the command is present, always validate this grammar. Reject duplicates, missing or empty values, extra syntax, and all
`--runtime`, `--context`, `--deployment`, `--preset`, `--seed-profile`, or `--seed`
options in either form. An empty command is valid only for a microservices choice
with both runtime readiness and provisioning availability explicitly false and a
matching nonempty blocker. Tool facts must be literal booleans, and the missing
tool list must match that map and the `KUBERNETES_TOOLS_MISSING` gate. With no
missing tools, an unavailable or unknown owned runtime requires its matching
`OWNED_KUBERNETES_UNAVAILABLE` or `OWNED_KUBERNETES_UNKNOWN` runtime gate.
A ready owned runtime instead requires insufficient or unknown capacity and the
matching `CAPACITY_BELOW_FLOOR` or `CAPACITY_UNKNOWN` capacity gate. Capacity
observations must be finite nonnegative numbers matching the environment facts,
with literal readiness/applicability booleans and status/code consistent with the
committed engine floor of 4 CPUs and 6 GiB. Never treat a ready runtime with
sufficient capacity, or usable Kind provisioning, as justification for a blank.
An unexplained empty command fails. The helper also runs a separate `onboard --show --json` process with a temporary
Node preload on the candidate's existing `host.engine`, `tools.which` and
`cluster.ownedRuntimeState` observation seams. It supplies a Docker engine with
8 CPUs, 16 GiB and kernel 6.6.0, present Docker/kubectl/Helm tools, absent Kind,
and a ready owned runtime. The candidate computes readiness and generates the
command itself. Require those exact reported facts, sufficient capacity, unchanged
saved choices and authority, no actions, and a nonempty command with the grammar
above. Require evidence that every controlled observation was called. Config
bytes must remain identical. Retain `setup-ready.stdout`, its stderr, the preload,
`setup-ready-observations.json` and before/after config hashes in the summary.
The preload applies only to this preview process. It does not implement setup,
invoke a cluster client, grant permission or establish real runtime readiness.
Keep blank-command, malformed-command, false-fact and config-write controls so
the blocked path cannot replace ready-command coverage. Require the ready response's
`gates` to hold exactly one `GATE_OWNED_CLUSTER` grant gate with its `houston onboard grant owned-cluster` approval, and none of
`KUBERNETES_TOOLS_MISSING`, `CAPACITY_BELOW_FLOOR`, `CAPACITY_UNKNOWN`,
`OWNED_KUBERNETES_UNAVAILABLE`, `OWNED_KUBERNETES_UNKNOWN` or `GATE_NOT_ONBOARDED`.
Those blockers contradict the controlled observations and completed onboarding.
Before saving anything, the first JSON preview must show the legacy fixture's answers:
deployment `monolith` for the saved `default`, no scenarios, seed profile `small` and
retention off. Compare those four fields one by one. The real `selection` also holds
`topology` and `kubernetes_target`. Human output must
show exactly one `deployment  <selected value>` line matching the saved selection,
as rendered by `humanLines` in `src/cli/handlers/setup.ts`. That renderer prints one
`  CODE: message` row per gate between its `seed deferred` and `first run` lines. The
rows must equal the gates of the JSON readback that ran just before, in order, so a
code or message mentioned elsewhere does not count and a changed denial text fails.
Incidental deployment names in engine or options text do not establish the selection.
Immediately after the human preview, compare exact config bytes with the saved
snapshot before parsing YAML or deriving the interactive expectation.
Persisted YAML must retain unknown fields
and legacy denials. Receipts are `setup-*`, `setup-persisted.json`, and
`commands.json`.

The helper then pipes answers through the real interactive seed section. Cancelling
must preserve config bytes. Accepting a new seed answer must survive a separate
preview process while preserving retention and authority. Re-read the actual YAML
after acceptance and compare the entire saved document with the pre-prompt
document, allowing only the accepted seed preference to change. This must retain
all legacy fields, cluster scopes, denials, and onboarding completion/version.
Retain `setup-interactive-persisted.json` as well as the explicit-save snapshot. This exercises buffered
stdin, not a terminal or Ctrl-C. For the shared API,
run the candidate's `test/web/routes/meta.test.ts` setup scenario and retain the
result at the exact source fingerprint. It calls the registered Fastify route,
requires unauthenticated refusal, permits a readonly session, excludes the
synthetic registration token, and checks unchanged configuration bytes. This
proves the in-process HTTP route boundary with test fixtures; it does not prove
browser UI behavior or a listening server. There is no setup panel in this port.

Engine readiness and capacity are read-only observations. No resize, provisioning,
cluster adoption, remote approval, or live workspace creation is exercised. Check
these remaining boundaries separately before claiming them. The CLI helper's
`PASS_SCOPED` result covers only its named offline paths.
