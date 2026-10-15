# PR #57 evidence closeout

Verified implementation revision: `20f0bc8c799572b5431869186ca58120a67001fe`
Branch: `mira/v2-evidence`
Remote PR head before this closeout: `e366bb9c8cec4accf93b6d2d9a1531ddf904bcab`

## Result

- Evidence chooses the deployment artifact from recorded runtime metadata, so a Docker-to-Kubernetes rebuild cannot attach stale Compose output.
- Kubernetes ownership is `label` only after a namespace-label read on the exact recorded context and namespace. Missing metadata, mismatched labels, unreadable labels, and ordinary read failures produce `unknown`; `Interrupted` propagates.
- Docker and Kubernetes create records retain only `reg_token_supplied: true` for an effective token. Evidence reports token provenance without persisting its value, and an explicit licence remains the preferred source.
- The bundle help and generated skill copies describe only the manifest, README, and available redacted deployment artifact. They no longer promise raw logs.
- The README uses `public_url` when present, preserves the cleanup command byte for byte, and does not recommend the unregistered `houston capture` command.
- The Jest floor moved from 4521 to 4530: nine new test declarations across the CLI handler, evidence, Docker-create, and Kubernetes-create suites.

## Verification

- `npx jest --ci --runInBand test/cli/handlers.test.ts test/core/evidence.test.ts test/core/kube/create-path.test.ts test/core/lifecycle/create-docker.test.ts` passed: 4 suites, 149 tests, zero skipped, zero todo.
- `npx tsc -p tsconfig.json --noEmit` passed.
- `npx eslint .` passed.
- `npx prettier --check "{src,test,tools}/**/*.{ts,js}" "*.mjs" "jest*.config.js" .dependency-cruiser.js` passed.
- `node tools/depcruise.js` passed with no dependency violations.
- `node tools/lint-truthiness.js` passed all five guard checks.
- Fresh isolated `HOUSTON_HOME` and `HOUSTON_SKILL_HOME` ran `node tools/skill-generate.js` and `--check`; all three shipped skill copies match the build.
- An isolated real CLI check ran `bin/houston capabilities` followed by `bin/houston evidence --help`. It confirmed the evidence JSON and `--bundle` contract, the safe bundle-file description, and the raw-log boundary.

## Limits

No Docker containers, Kubernetes clusters, namespace mutations, or credential-bearing workspace were started. The Kubernetes result is covered by mocked owner-boundary tests; a live cluster label read remains untested. The full Jest suite is intentionally deferred to the fork's Linux CI. `node tools/zero-skips-selftest.js` remains incomplete on macOS because its conditional-firing fixture hard-codes Linux; it fails before evaluating the floor and was not changed by this closeout.

Proof: branch 4, targeted repository tests and an isolated direct CLI check on `20f0bc8c799572b5431869186ca58120a67001fe` demonstrated the changed evidence and help contracts; live Docker and Kubernetes behavior remain untested.
