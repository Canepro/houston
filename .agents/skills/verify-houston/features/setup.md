# Goal-first setup

Read `src/core/setup.ts`, `src/cli/handlers/setup.ts`, the onboard command in
`src/cli/spec-data.ts`, and `src/web/routes/meta.ts` on the candidate. When onboard
advertises `--show`, the helper drives the real CLI in its disposable home after
the onboarding checks. The outer JSON schema remains `houston.onboard.v1`; setup
responses carry `data.schema: houston.setup.v1`.

The preview must preserve configuration bytes, report saved answers, and offer no
automatic infrastructure actions. Empty JSON setup, an invalid deployment, and
`--show` combined with a write must each refuse with exit 2 and
`VALIDATION_FAILED`, leaving the configuration unchanged.

The helper saves microservices, no scenarios, no seed, and retention enabled. A
separate preview process must read these choices back. Accepting defaults must
preserve those answers and the denied owned-cluster grant without rewriting the
configuration when every default was already answered. The resulting command must
use the saved topology and omit `--runtime`, `--context`, `--deployment`, and
`--preset`; parse it as shell tokens before checking that it also omits seed flags. Human output must
show the deployment and authority gate. Persisted YAML must retain unknown fields
and legacy denials. Receipts are `setup-*`, `setup-persisted.json`, and
`commands.json`.

The helper then pipes answers through the real interactive seed section. Cancelling
must preserve config bytes. Accepting a new seed answer must survive a separate
preview process while preserving retention and authority. This exercises buffered
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
